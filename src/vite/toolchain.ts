/// <reference types="node" />
// Locating the container2wasm converter.
//
// The plugin already requires Docker, so the last resort builds the pinned
// converter in a Go container rather than downloading a binary or asking for a
// Go toolchain. It runs once and the result is cached next to the converted
// images, which keeps the setup instructions for a consumer at "install
// Docker".

import { spawn } from 'node:child_process'
import { access, chmod, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'

export const C2W_VERSION = 'v0.8.4'
export const C2W_COMMIT = '6ed3d98882a2b22eafc1334f574c364a5b2b8c47'
const GO_IMAGE = 'golang:1.23-alpine'

export type RunResult = { code: number; stdout: string; stderr: string }

export const run = (
  command: string,
  args: string[],
  options: { cwd?: string; onLine?: (line: string) => void } = {},
): Promise<RunResult> => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
    options.onLine?.(chunk.toString().trimEnd())
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
    options.onLine?.(chunk.toString().trimEnd())
  })
  child.on('error', reject)
  child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
})

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export const assertDocker = async (builder: string): Promise<void> => {
  const result = await run(builder, ['version', '--format', '{{.Server.Version}}'])
  if (result.code !== 0) {
    throw new Error(
      'Could not reach the Docker daemon with "' + builder + '". ' +
      'Building a container image for the browser needs Docker running locally. ' +
      (result.stderr.trim() || result.stdout.trim()),
    )
  }
}

export type ToolchainOptions = {
  cacheDir: string
  builder: string
  c2wPath?: string
  log: (message: string) => void
}

let inFlight: Promise<string> | null = null

export const resolveConverter = async (options: ToolchainOptions): Promise<string> => {
  if (options.c2wPath) {
    if (!await exists(options.c2wPath)) {
      throw new Error('c2wPath does not point at an executable: ' + options.c2wPath)
    }
    return options.c2wPath
  }

  const onPath = await run('c2w', ['--version'])
  if (onPath.code === 0) return 'c2w'

  const cached = join(options.cacheDir, 'c2w-' + C2W_VERSION)
  if (await exists(cached)) return cached

  inFlight ??= (async () => {
    await mkdir(options.cacheDir, { recursive: true })
    options.log('building the container2wasm converter ' + C2W_VERSION + ' (one time, a minute or two)')
    const script = [
      'apk add --no-cache git >/dev/null',
      'git clone --quiet --depth 1 --branch ' + C2W_VERSION +
        ' https://github.com/container2wasm/container2wasm.git /src',
      'test "$(git -C /src rev-parse HEAD)" = "' + C2W_COMMIT + '"',
      'cd /src && go build -trimpath -o /out/c2w-' + C2W_VERSION + ' ./cmd/c2w',
    ].join(' && ')
    const result = await run(options.builder, [
      'run', '--rm',
      '-v', options.cacheDir + ':/out',
      GO_IMAGE, 'sh', '-c', script,
    ])
    if (result.code !== 0) {
      throw new Error('could not build the container2wasm converter:\n' + result.stderr.trim())
    }
    await chmod(cached, 0o755)
    return cached
  })().finally(() => { inFlight = null })

  return inFlight
}
