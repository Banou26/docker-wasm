import { manifestPlatforms, dockerfileFromRefs } from './registry'

export type BuilderArch = 'riscv64' | 'amd64'

export type GuestKind = 'runner' | 'builder'

export type Builder = {
  arch: BuilderArch
  kind: GuestKind
  wasmPath: string
  platform: { os: string; arch: string }
  // Brotli-compressed size, measured rather than guessed, so the status view can show a real total before the first byte arrives.
  approximateDownloadBytes: number
  baseImage?: string
  baseImageConfig?: {
    env?: string[]
    workdir?: string
    entrypoint?: string[]
    cmd?: string[]
  }
}

// docker.io/library/alpine:3.21, checked against the registry by `npm run verify-guest-base` rather than trusted.
const ALPINE_321_CONFIG = {
  env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'],
  workdir: '/',
  cmd: ['/bin/sh'],
}

// Only tagged refs match, since `latest` moves and guessing wrong means building against the wrong base.
export const sameImage = (a: string, b: string): boolean => {
  const normalise = (ref: string): string => {
    let rest = ref.trim()
    if (rest.startsWith('docker.io/')) rest = rest.slice('docker.io/'.length)
    if (rest.startsWith('library/')) rest = rest.slice('library/'.length)
    return rest
  }
  return normalise(a) === normalise(b) && a.includes(':') && b.includes(':')
}

export const GUESTS: Record<GuestKind, Record<BuilderArch, Builder>> = {
  runner: {
    riscv64: {
      arch: 'riscv64', kind: 'runner',
      wasmPath: '/playground/runner-riscv64.wasm',
      platform: { os: 'linux', arch: 'riscv64' },
      approximateDownloadBytes: 15_400_000,
      baseImage: 'alpine:3.21',
      baseImageConfig: ALPINE_321_CONFIG,
    },
    amd64: {
      arch: 'amd64', kind: 'runner',
      wasmPath: '/playground/runner.wasm',
      platform: { os: 'linux', arch: 'amd64' },
      approximateDownloadBytes: 30_900_000,
      baseImage: 'alpine:3.21',
      baseImageConfig: ALPINE_321_CONFIG,
    },
  },
  builder: {
    riscv64: {
      arch: 'riscv64', kind: 'builder',
      wasmPath: '/playground/playground-riscv64.wasm',
      platform: { os: 'linux', arch: 'riscv64' },
      approximateDownloadBytes: 37_900_000,
    },
    amd64: {
      arch: 'amd64', kind: 'builder',
      wasmPath: '/playground/playground.wasm',
      platform: { os: 'linux', arch: 'amd64' },
      approximateDownloadBytes: 48_900_000,
    },
  },
}

export const BUILDERS: Record<BuilderArch, Builder> = GUESTS.builder

// amd64 until the riscv64 guest's `wget` of the base image archive from the in-page gateway stops stalling indefinitely.
export const DEFAULT_BUILDER_ARCH = 'amd64' as BuilderArch

export type BuilderChoice = {
  builder: Builder
  reason: string
  unsupportedRefs: string[]
}

const choiceCache = new Map<string, Promise<boolean>>()

const hasRiscv64 = (ref: string): Promise<boolean> => {
  const cached = choiceCache.get(ref)
  if (cached) return cached
  const probe = manifestPlatforms(ref)
    .then((platforms) => platforms.some((p) => p.arch === 'riscv64' && p.os === 'linux'))
    // A ref that cannot be resolved is not evidence either way, so answer no and get the builder that can run anything rather than one that may not.
    .catch(() => false)
  choiceCache.set(ref, probe)
  return probe
}

export const chooseBuilder = async (dockerfileText: string): Promise<BuilderChoice> => {
  const refs = dockerfileFromRefs(dockerfileText)
  const fallback = BUILDERS[DEFAULT_BUILDER_ARCH]

  if (refs.length === 0) {
    return { builder: fallback, reason: 'No base image to pull', unsupportedRefs: [] }
  }

  const supported = await Promise.all(refs.map(hasRiscv64))
  const unsupportedRefs = refs.filter((_, index) => !supported[index])

  // While the default is amd64 the probe result is advisory: running it now keeps the path exercised rather than dead code.
  if (DEFAULT_BUILDER_ARCH !== 'riscv64') {
    return {
      builder: fallback,
      reason: unsupportedRefs.length === 0
        ? 'Every base image has a riscv64 build, but the fast builder is not enabled yet'
        : unsupportedRefs.join(', ') + ' would need the compatibility builder regardless',
      unsupportedRefs,
    }
  }

  if (unsupportedRefs.length === 0) {
    return {
      builder: BUILDERS.riscv64,
      reason: refs.length === 1
        ? refs[0] + ' has a riscv64 build, so this uses the fast builder'
        : 'Every base image has a riscv64 build, so this uses the fast builder',
      unsupportedRefs: [],
    }
  }

  return {
    builder: BUILDERS.amd64,
    reason: unsupportedRefs.join(', ') + (unsupportedRefs.length === 1 ? ' has' : ' have') +
      ' no riscv64 build, falling back to the compatibility builder',
    unsupportedRefs,
  }
}
