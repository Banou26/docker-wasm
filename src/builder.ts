// Which builder guest runs a given Dockerfile, and what that implies for the
// base images pulled into it.
//
// There are two builder artifacts. riscv64 runs on c2w's TinyEMU backend and is
// the one worth waiting for; amd64 runs on Bochs, which needs asyncify
// instrumentation and is both larger and slower, but will build anything.
//
// The deciding fact is the base image, not a preference: buildah inside a
// riscv64 guest has to execute the RUN steps of a riscv64 rootfs, so every FROM
// in the Dockerfile needs a riscv64 variant on the registry. Alpine, Debian,
// Ubuntu and busybox publish one; most language images do not.

import { manifestPlatforms, dockerfileFromRefs } from './registry'

export type BuilderArch = 'riscv64' | 'amd64'

// Which guest, independent of architecture.
//
// `runner` is bare alpine: busybox has the wget, tar and chroot the fast path
// needs, and nothing else. `builder` additionally carries buildah, for
// Dockerfiles the fast path cannot express. The difference is not marginal:
// carrying buildah roughly triples the download and moves the boot from a
// TinyEMU-class ~1.2s to a Bochs-class ~8s.
export type GuestKind = 'runner' | 'builder'

export type Builder = {
  arch: BuilderArch
  kind: GuestKind
  // Path to the converted guest, before asset versioning.
  wasmPath: string
  // Platform the page must pull base images for, so the layers it hands the
  // guest are executable inside it.
  platform: { os: string; arch: string }
  // Brotli-compressed size, measured rather than guessed, so the status view can
  // show a real total before the first byte arrives.
  approximateDownloadBytes: number
}

export const GUESTS: Record<GuestKind, Record<BuilderArch, Builder>> = {
  runner: {
    riscv64: {
      arch: 'riscv64', kind: 'runner',
      wasmPath: '/playground/runner-riscv64.wasm',
      platform: { os: 'linux', arch: 'riscv64' },
      approximateDownloadBytes: 15_400_000,
    },
    amd64: {
      arch: 'amd64', kind: 'runner',
      wasmPath: '/playground/runner.wasm',
      platform: { os: 'linux', arch: 'amd64' },
      approximateDownloadBytes: 30_900_000,
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

// Kept for the existing buildah call sites; the fast path goes through GUESTS.
export const BUILDERS: Record<BuilderArch, Builder> = GUESTS.builder

// amd64 until the riscv64 guest's inbound fetch from the artifact bridge is
// fixed: it boots in 7.8s and is a third smaller, but `wget` of the base image
// archive from the in-page gateway stalls indefinitely, where the amd64 guest
// completes it over the same bridge. Everything else here is ready for the flip.
export const DEFAULT_BUILDER_ARCH = 'amd64' as BuilderArch

export type BuilderChoice = {
  builder: Builder
  // Why, in words the status view can show without further translation.
  reason: string
  // Refs that forced amd64, if any.
  unsupportedRefs: string[]
}

const choiceCache = new Map<string, Promise<boolean>>()

// Whether one image reference publishes a riscv64 variant. Manifest lists only,
// so this is one small request per ref and safe to run while the user types.
const hasRiscv64 = (ref: string): Promise<boolean> => {
  const cached = choiceCache.get(ref)
  if (cached) return cached
  const probe = manifestPlatforms(ref)
    .then((platforms) => platforms.some((p) => p.arch === 'riscv64' && p.os === 'linux'))
    // A ref we cannot resolve is not evidence either way. Say no, so the answer
    // is the builder that can run anything rather than one that may not.
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

  // While the default is amd64 the probe result is advisory: it decides nothing
  // yet, but it is what the flip will switch on, and running it now keeps the
  // path exercised rather than dead code.
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
