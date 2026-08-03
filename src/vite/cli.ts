#!/usr/bin/env node
/// <reference types="node" />

import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { buildContainerImage, type TargetArch } from './build-image'

const USAGE = `fkn-container build <dockerfile> [options]

Options:
  --out <path>        Where to write the .wasm (default: alongside the cache)
  --context <dir>     Build context (default: the Dockerfile's directory)
  --arch <arch>       amd64 (default) or riscv64
  --memory <MiB>      Guest RAM, 32 to 4096 (default: 128)
  --target <stage>    Dockerfile stage to build
  --cache-dir <dir>   Conversion cache (default: node_modules/.cache/fkn-container)
  --builder <cmd>     Container CLI (default: docker)
`

type Options = Record<string, string | undefined>

const parse = (argv: string[]): { command?: string; positional: string[]; options: Options } => {
  const positional: string[] = []
  const options: Options = {}
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const [name, inline] = token.slice(2).split('=', 2)
    if (inline !== undefined) options[name!] = inline
    else options[name!] = argv[++index]
  }
  return { command: positional[0], positional: positional.slice(1), options }
}

const main = async (): Promise<number> => {
  const { command, positional, options } = parse(process.argv.slice(2))
  if (command !== 'build' || positional.length !== 1) {
    process.stdout.write(USAGE)
    return command === undefined || command === 'help' ? 0 : 1
  }

  const arch = options.arch
  if (arch !== undefined && arch !== 'amd64' && arch !== 'riscv64') {
    process.stderr.write('unsupported arch: ' + arch + '\n')
    return 1
  }
  const memory = options.memory === undefined ? undefined : Number(options.memory)
  if (memory !== undefined && (!Number.isInteger(memory) || memory < 32 || memory > 4096)) {
    process.stderr.write('memory must be an integer between 32 and 4096\n')
    return 1
  }

  const cacheDir = resolve(options['cache-dir'] ?? join('node_modules', '.cache', 'fkn-container'))
  const artifact = await buildContainerImage({
    dockerfile: resolve(positional[0]!),
    context: options.context ? resolve(options.context) : undefined,
    arch: arch as TargetArch | undefined,
    memoryMB: memory,
    target: options.target,
  }, {
    cacheDir,
    builder: options.builder ?? 'docker',
    log: (message) => process.stderr.write('[container] ' + message + '\n'),
  })

  let destination = artifact.path
  if (options.out) {
    destination = resolve(options.out)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(artifact.path, destination)
  }

  process.stderr.write(
    '[container] ' + (artifact.fromCache ? 'reused' : 'built') + ' ' +
    (artifact.bytes / 1e6).toFixed(1) + ' MB for linux/' + artifact.arch + '\n',
  )
  process.stdout.write(destination + '\n')
  return 0
}

main().then(
  (code) => { process.exitCode = code },
  (error: unknown) => {
    process.stderr.write(String(error instanceof Error ? error.message : error) + '\n')
    process.exitCode = 1
  },
)
