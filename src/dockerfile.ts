// Be conservative: a wrong "yes" produces a silently incorrect image, while a wrong "no" only costs time.

export type Instruction = {
  name: string
  args: string
  // 1-based, and the line the instruction *started* on, so an error about a continued instruction points at something the user can see.
  line: number
}

export type ParsedDockerfile = {
  instructions: Instruction[]
  baseRefs: string[]
  // A `# escape=` or `# syntax=` directive means this parser is not reading the same document the real builder would, which is why its presence forces the buildah fallback.
  directives: string[]
}

const CONTINUES = /\\\s*$/
const DIRECTIVE = /^#\s*(escape|syntax|check)\s*=/i

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

    // A comment *inside* a continued instruction does not end it, so skip without touching the buffer.
    if (trimmed.startsWith('#')) {
      if (!seenInstruction && DIRECTIVE.test(trimmed)) directives.push(trimmed)
      continue
    }
    if (!trimmed && buffer) continue
    if (!buffer) {
      if (!trimmed) continue
      startLine = i + 1
    }

    // Docker joins continuation lines with nothing between them; a newline here turns one command into several.
    buffer += raw.replace(CONTINUES, '')
    if (!CONTINUES.test(raw)) flush()
  }
  flush()

  return {
    instructions,
    directives,
    baseRefs: instructions
      .filter((instruction) => instruction.name === 'FROM')
      .map((instruction) => instruction.args.split(/\s+/).filter((part) => !part.startsWith('--'))[0] || '')
      .filter(Boolean),
  }
}

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

// Kept as structure, not resolved: the value depends on the base image's own environment, unknown until the pull.
export type WordPart =
  | { kind: 'literal'; value: string }
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

// For status lines and error messages, not for the shell: use `renderWord` in build-script.ts for that.
export const wordText = (parts: WordPart[]): string =>
  parts.map((part) => (part.kind === 'literal' ? part.value : '$' + part.expression)).join('')

export type EnvBinding = { key: string; value: WordPart[] }

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

// Deliberately small: every entry is an instruction whose whole effect is either a command to run in the rootfs or a piece of metadata the launcher applies itself. Do not widen it casually.
const CHROOT_SUPPORTED = new Set([
  'FROM', 'RUN', 'ENV', 'WORKDIR', 'CMD', 'ENTRYPOINT', 'EXPOSE', 'LABEL', 'MAINTAINER',
])

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

// The state is carried per step, not per build: an ENV below a RUN must not reach it.
export type BuildStep = {
  command: string
  // 1-based, and the line the instruction *started* on, so an error about a continued instruction points at something the user can see.
  line: number
  env: EnvBinding[]
  workdirs: WordPart[][]
}

export type ChrootPlan = {
  engine: 'chroot'
  base: string
  steps: BuildStep[]
  env: EnvBinding[]
  workdirs: WordPart[][]
  cmd: string[] | string | null
  entrypoint: string[] | string | null
  exposed: number[]
}

export type BuildahPlan = {
  engine: 'buildah'
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
  if (/\s+AS\s+\S+\s*$/i.test(instructions[0].args)) {
    return { engine: 'buildah', reason: 'Named build stage' }
  }
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
        if (instruction.args.startsWith('--')) {
          return { engine: 'buildah', reason: 'RUN uses a build option the fast path cannot provide' }
        }
        if (instruction.args.includes('<<')) {
          return { engine: 'buildah', reason: 'RUN uses a heredoc' }
        }
        const exec = parseExecForm(instruction.args)
        plan.steps.push({
          command: exec ? exec.map(shellQuote).join(' ') : instruction.args,
          line: instruction.line,
          env: plan.env.slice(),
          workdirs: plan.workdirs.slice(),
        })
        break
      }
      case 'ENV':
        // Append, never collapse to a map: `ENV A=1` / `ENV B=$A` / `ENV A=2` leaves B as 1, a map leaves it as 2.
        plan.env = [...plan.env, ...parseEnv(instruction.args)]
        break
      case 'WORKDIR':
        // Appended, never collapsed: `cd` in sequence reproduces both `/usr` + `local` and a later absolute reset.
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

export const shellQuote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'"
