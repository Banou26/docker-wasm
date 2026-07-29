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
  // A `# escape=` or `# syntax=` directive, which changes how the rest of the
  // file is parsed or which frontend builds it. Either one means this parser is
  // not reading the same document the real builder would.
  directives: string[]
}

const CONTINUES = /\\\s*$/
const DIRECTIVE = /^#\s*(escape|syntax|check)\s*=/i

// Joins continuation lines, drops comments and blank lines. Comments are only
// comments at the start of a line: a `#` inside a RUN is part of the command.
export const parseDockerfile = (text: string): ParsedDockerfile => {
  const instructions: Instruction[] = []
  const directives: string[] = []
  const lines = text.split('\n')

  let buffer = ''
  let startLine = 0
  let seenInstruction = false

  const flush = (): void => {
    const trimmed = buffer.trim()
    buffer = ''
    if (!trimmed) return
    const match = /^([A-Za-z][A-Za-z0-9_]*)\s*([\s\S]*)$/.exec(trimmed)
    if (!match) return
    seenInstruction = true
    instructions.push({ name: match[1]!.toUpperCase(), args: match[2]!.trim(), line: startLine })
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const trimmed = raw.trim()

    // A comment is stripped wherever it appears, and one *inside* a continued
    // instruction does not end it: the backslash on the line above is still in
    // effect. Skipping without touching the buffer is exactly that behaviour.
    if (trimmed.startsWith('#')) {
      // Directives are comments, but only before the first instruction.
      if (!seenInstruction && DIRECTIVE.test(trimmed)) directives.push(trimmed)
      continue
    }
    // A blank line inside a continuation is likewise skipped rather than
    // treated as the end of the instruction.
    if (!trimmed && buffer) continue
    if (!buffer) {
      if (!trimmed) continue
      startLine = i + 1
    }

    // Docker removes the backslash and the newline, joining the lines with
    // nothing between them. Joining with a newline instead turns one command
    // into several, which is a different build rather than a failed one.
    buffer += raw.replace(CONTINUES, '')
    if (!CONTINUES.test(raw)) flush()
  }
  flush()

  return {
    instructions,
    directives,
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

// A Dockerfile value that may reference other variables.
//
// `ENV PATH=/opt/bin:$PATH` has to reach the guest as something the shell will
// expand, and `ENV MSG='costs $5'` has to reach it as something the shell will
// not. Resolving either one here is impossible: the value depends on the base
// image's own environment, which is not known until the image is pulled, and on
// earlier ENVs whose values have the same problem. So keep the structure and let
// the emitter hand the shell a string that expands to the right thing.
export type WordPart =
  | { kind: 'literal'; value: string }
  // The text inside `${...}`, so `PATH`, or `PORT:-8080`. Passed through rather
  // than modelled, because sh and Dockerfile agree on this syntax.
  | { kind: 'variable'; expression: string }

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*/

const readVariable = (raw: string, start: number): { part: WordPart; next: number } | null => {
  if (raw[start + 1] === '{') {
    const close = raw.indexOf('}', start + 2)
    if (close === -1) return null
    const inner = raw.slice(start + 2, close)
    if (!VARIABLE_NAME.test(inner)) return null
    return { part: { kind: 'variable', expression: inner }, next: close + 1 }
  }
  const match = VARIABLE_NAME.exec(raw.slice(start + 1))
  if (!match) return null
  return { part: { kind: 'variable', expression: match[0] }, next: start + 1 + match[0].length }
}

// Splits a raw Dockerfile value into literal and variable parts, honouring the
// quoting rules Docker applies: no expansion inside single quotes, expansion
// inside double quotes and outside quotes, and a backslash that makes the next
// character literal.
export const parseWord = (raw: string): WordPart[] => {
  const parts: WordPart[] = []
  let buffer = ''
  let quote: '"' | "'" | null = null

  const flushLiteral = (): void => {
    if (!buffer) return
    parts.push({ kind: 'literal', value: buffer })
    buffer = ''
  }

  let i = 0
  while (i < raw.length) {
    const char = raw[i]!
    if (quote === "'") {
      if (char === "'") quote = null
      else buffer += char
      i++
      continue
    }
    if (char === '\\' && i + 1 < raw.length) {
      // `\$` is a literal dollar, which is the whole reason the backslash has to
      // survive this far rather than being stripped when the quotes were.
      buffer += raw[i + 1]
      i += 2
      continue
    }
    if (char === '"') {
      quote = quote === '"' ? null : '"'
      i++
      continue
    }
    if (char === "'" && quote === null) {
      quote = "'"
      i++
      continue
    }
    if (char === '$') {
      const variable = readVariable(raw, i)
      if (variable) {
        flushLiteral()
        parts.push(variable.part)
        i = variable.next
        continue
      }
    }
    buffer += char
    i++
  }
  flushLiteral()
  return parts
}

// The word as a human would write it, for status lines and error messages. Not
// for the shell: use `renderWord` in build-script.ts for that.
export const wordText = (parts: WordPart[]): string =>
  parts.map((part) => (part.kind === 'literal' ? part.value : '$' + part.expression)).join('')

export type EnvBinding = { key: string; value: WordPart[] }

// `ENV a=1 b=2` and the legacy `ENV a 1`. Values may be quoted, and are kept as
// parsed words rather than strings so the emitter can decide what expands.
export const parseEnv = (args: string): EnvBinding[] => {
  const trimmed = args.trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) {
    const space = trimmed.search(/\s/)
    if (space === -1) return [{ key: trimmed, value: [] }]
    return [{ key: trimmed.slice(0, space), value: parseWord(trimmed.slice(space + 1).trim()) }]
  }

  const bindings: EnvBinding[] = []
  const pattern = /([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'[^']*'|(?:[^\s\\]|\\.)*)/g
  for (let match = pattern.exec(trimmed); match; match = pattern.exec(trimmed)) {
    bindings.push({ key: match[1]!, value: parseWord(match[2]!) })
  }
  return bindings
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

// One RUN, together with the state docker would have had in effect at exactly
// that position. Carrying the state per step rather than once per build is what
// makes ordering work: an ENV below a RUN must not reach it, a re-assigned
// variable must take its earlier value above the re-assignment, and a WORKDIR
// applies only to what follows it.
export type BuildStep = {
  // The shell command, already joined if it was written in exec form.
  command: string
  // 1-based Dockerfile line, so the status view can point at the source.
  line: number
  env: EnvBinding[]
  // Every WORKDIR in effect, in declaration order. A chain rather than a single
  // resolved path because `WORKDIR /usr` then `WORKDIR local` means /usr/local,
  // and either segment may itself be a variable: `cd` in sequence resolves both
  // exactly the way docker does, without this module guessing at the value.
  workdirs: WordPart[][]
}

export type ChrootPlan = {
  engine: 'chroot'
  base: string
  steps: BuildStep[]
  // The same state, after the last instruction, for the launched process.
  env: EnvBinding[]
  workdirs: WordPart[][]
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
  const { instructions, baseRefs, directives } = parseDockerfile(text)

  if (directives.length > 0) {
    return { engine: 'buildah', reason: directives[0]!.trim() + ' changes how the file is built' }
  }
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
  // A pinned platform is a promise about what the RUN steps execute on, and the
  // fast path can only offer the guest's own.
  if (/(^|\s)--platform=/.test(instructions[0].args)) {
    return { engine: 'buildah', reason: 'FROM pins a platform' }
  }

  const plan: ChrootPlan = {
    engine: 'chroot',
    base: baseRefs[0]!,
    steps: [],
    env: [],
    workdirs: [],
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
        // `RUN --mount=...` and friends are buildkit options, not part of the
        // command. Running them as one would execute something else entirely.
        if (instruction.args.startsWith('--')) {
          return { engine: 'buildah', reason: 'RUN uses a build option the fast path cannot provide' }
        }
        // A heredoc body is written on the lines below the instruction, which
        // this parser reads as further instructions rather than as its input.
        if (instruction.args.includes('<<')) {
          return { engine: 'buildah', reason: 'RUN uses a heredoc' }
        }
        const exec = parseExecForm(instruction.args)
        // The exec form bypasses a shell, but everything here runs through one
        // anyway, so quote each argument rather than pretending otherwise.
        plan.steps.push({
          command: exec ? exec.map(shellQuote).join(' ') : instruction.args,
          line: instruction.line,
          // Snapshots, not references: later instructions must not reach back
          // and change what an earlier step saw.
          env: plan.env.slice(),
          workdirs: plan.workdirs.slice(),
        })
        break
      }
      case 'ENV':
        // Append rather than overwrite, so a re-assignment stays a second entry.
        // Replaying the whole list in order is then the same computation the
        // real builder did: `ENV A=1` / `ENV B=$A` / `ENV A=2` leaves B as 1,
        // where collapsing to a map first would leave it as 2.
        plan.env = [...plan.env, ...parseEnv(instruction.args)]
        break
      case 'WORKDIR':
        // Appended, never collapsed. `cd` already treats an absolute path as a
        // reset, so the chain reproduces both `WORKDIR /usr` + `WORKDIR local`
        // meaning /usr/local and a later absolute WORKDIR replacing it, and it
        // keeps creating the intermediate directories docker creates.
        plan.workdirs = [...plan.workdirs, parseWord(instruction.args.trim())]
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
