// Parses a Dockerfile and decides which of the two build engines can run it.
//
// Buildah is correct for everything but spends almost all of its time on
// bookkeeping the page never uses: loading a 3.6 MB base image into its overlay
// store costs about 55 seconds, and committing a new layer another 33, to
// produce an OCI image nobody exports. Measured on both amd64 and riscv64, and
// near-identical on each, so it is I/O and syscall bound rather than emulation
// bound: no faster emulator fixes it.
//
// The fast path skips all of it. The page already assembles the base image in
// JavaScript, so the guest can extract that rootfs, run the RUN steps under
// chroot, and launch the result. That covers the instructions a pasted
// Dockerfile actually uses. Anything it cannot express falls back to buildah,
// which is why this module's job is to be conservative: a wrong "yes" produces a
// silently incorrect image, while a wrong "no" only costs time.

export type Instruction = {
  name: string
  args: string
  // 1-based, and the line the instruction *started* on, so an error about a
  // continued instruction points at something the user can see.
  line: number
}

export type ParsedDockerfile = {
  instructions: Instruction[]
  // Every FROM, in order. More than one means a multi-stage build.
  baseRefs: string[]
}

const CONTINUES = /\\\s*$/

// Joins continuation lines, drops comments and blank lines. Comments are only
// comments at the start of a line: a `#` inside a RUN is part of the command.
export const parseDockerfile = (text: string): ParsedDockerfile => {
  const instructions: Instruction[] = []
  const lines = text.split('\n')

  let buffer = ''
  let startLine = 0

  const flush = (): void => {
    const trimmed = buffer.trim()
    buffer = ''
    if (!trimmed) return
    const match = /^([A-Za-z][A-Za-z0-9_]*)\s*([\s\S]*)$/.exec(trimmed)
    if (!match) return
    instructions.push({ name: match[1]!.toUpperCase(), args: match[2]!.trim(), line: startLine })
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    if (!buffer && (!raw.trim() || raw.trim().startsWith('#'))) continue
    if (!buffer) startLine = i + 1
    buffer += (buffer ? '\n' : '') + raw.replace(CONTINUES, '')
    if (!CONTINUES.test(raw)) flush()
  }
  flush()

  return {
    instructions,
    baseRefs: instructions
      .filter((instruction) => instruction.name === 'FROM')
      // `FROM --platform=x ref AS name` -> ref
      .map((instruction) => instruction.args.split(/\s+/).filter((part) => !part.startsWith('--'))[0] || '')
      .filter(Boolean),
  }
}

// Docker's exec form is a JSON array; anything else is the shell form. Docker
// only accepts double quotes here, and so does this.
export const parseExecForm = (args: string): string[] | null => {
  const trimmed = args.trim()
  if (!trimmed.startsWith('[')) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (!Array.isArray(parsed) || !parsed.every((part) => typeof part === 'string')) return null
    return parsed as string[]
  } catch {
    return null
  }
}

// `ENV a=1 b=2` and the legacy `ENV a 1`. Values may be quoted.
export const parseEnv = (args: string): Array<[string, string]> => {
  const trimmed = args.trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) {
    const space = trimmed.search(/\s/)
    if (space === -1) return [[trimmed, '']]
    return [[trimmed.slice(0, space), unquote(trimmed.slice(space + 1).trim())]]
  }

  const pairs: Array<[string, string]> = []
  const pattern = /([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'[^']*'|[^\s]*)/g
  for (let match = pattern.exec(trimmed); match; match = pattern.exec(trimmed)) {
    pairs.push([match[1]!, unquote(match[2]!)])
  }
  return pairs
}

const unquote = (value: string): string => {
  if (value.length >= 2 && value[0] === '"' && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, '$1')
  }
  if (value.length >= 2 && value[0] === "'" && value.endsWith("'")) return value.slice(1, -1)
  return value
}

// What the fast path can carry out. Deliberately small: every entry here is an
// instruction whose whole effect is either a command to run in the rootfs or a
// piece of metadata the launcher applies itself.
const CHROOT_SUPPORTED = new Set([
  'FROM', 'RUN', 'ENV', 'WORKDIR', 'CMD', 'ENTRYPOINT', 'EXPOSE', 'LABEL', 'MAINTAINER',
])

// Reasons to fall back, phrased for the status view rather than for a log.
const FALLBACK_REASONS: Record<string, string> = {
  COPY: 'COPY needs a build context',
  ADD: 'ADD needs a build context',
  ARG: 'ARG needs build-time variable substitution',
  USER: 'USER changes the build user',
  VOLUME: 'VOLUME declares a mount point',
  SHELL: 'SHELL replaces the default shell',
  HEALTHCHECK: 'HEALTHCHECK is a runtime probe',
  ONBUILD: 'ONBUILD defers instructions to a child build',
  STOPSIGNAL: 'STOPSIGNAL is a runtime signal',
}

export type ChrootPlan = {
  engine: 'chroot'
  base: string
  // Shell commands, in order, each run inside the extracted rootfs.
  runs: string[]
  env: Array<[string, string]>
  workdir: string | null
  cmd: string[] | string | null
  entrypoint: string[] | string | null
  exposed: number[]
}

export type BuildahPlan = {
  engine: 'buildah'
  // Why the fast path was declined, for the status view.
  reason: string
}

export type BuildPlan = ChrootPlan | BuildahPlan

export const planBuild = (text: string): BuildPlan => {
  const { instructions, baseRefs } = parseDockerfile(text)

  if (baseRefs.length === 0) return { engine: 'buildah', reason: 'No FROM instruction' }
  if (baseRefs.length > 1) return { engine: 'buildah', reason: 'Multi-stage build' }
  if (instructions[0]?.name !== 'FROM') {
    return { engine: 'buildah', reason: 'Something precedes FROM' }
  }
  // `AS name` only means anything with a second stage, but its presence suggests
  // one is intended, and buildah is the honest answer for an unfinished file.
  if (/\s+AS\s+\S+\s*$/i.test(instructions[0].args)) {
    return { engine: 'buildah', reason: 'Named build stage' }
  }

  const plan: ChrootPlan = {
    engine: 'chroot',
    base: baseRefs[0]!,
    runs: [],
    env: [],
    workdir: null,
    cmd: null,
    entrypoint: null,
    exposed: [],
  }

  for (const instruction of instructions) {
    if (!CHROOT_SUPPORTED.has(instruction.name)) {
      return {
        engine: 'buildah',
        reason: FALLBACK_REASONS[instruction.name]
          ?? instruction.name + ' is not supported by the fast path',
      }
    }

    switch (instruction.name) {
      case 'FROM': case 'LABEL': case 'MAINTAINER':
        break
      case 'RUN': {
        const exec = parseExecForm(instruction.args)
        // The exec form bypasses a shell, but everything here runs through one
        // anyway, so quote each argument rather than pretending otherwise.
        plan.runs.push(exec ? exec.map(shellQuote).join(' ') : instruction.args)
        break
      }
      case 'ENV':
        plan.env.push(...parseEnv(instruction.args))
        break
      case 'WORKDIR':
        plan.workdir = unquote(instruction.args.trim())
        break
      case 'CMD':
        plan.cmd = parseExecForm(instruction.args) ?? instruction.args
        break
      case 'ENTRYPOINT':
        plan.entrypoint = parseExecForm(instruction.args) ?? instruction.args
        break
      case 'EXPOSE':
        for (const part of instruction.args.split(/\s+/)) {
          const port = Number(part.split('/')[0])
          if (Number.isInteger(port) && port > 0 && port < 65536) plan.exposed.push(port)
        }
        break
    }
  }

  return plan
}

// Single-quote for /bin/sh, closing and reopening around embedded quotes.
export const shellQuote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'"
