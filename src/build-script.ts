// The guest side of the fast path.
//
// Instead of handing buildah a docker-archive and asking for an OCI image, the
// page hands the guest the base image's layers and asks it to untar them and
// chroot in. That drops the two phases that dominate an in-browser build:
// loading the archive into buildah's overlay store (~55s for a 3.6 MB image) and
// committing a layer afterwards (~33s), neither of which produces anything this
// page uses.
//
// What comes back is not an OCI image, which is exactly why this is a fast path
// and not a replacement: `src/dockerfile.ts` decides what it can handle.

import type { ChrootPlan } from './dockerfile'
import { shellQuote } from './dockerfile'

// Where the page's artifact bridge answers inside the guest.
export const GATEWAY = '192.168.127.1:9090'

export type LayerRef = {
  // Key the page registered the layer bytes under, in application order.
  key: string
  bytes: number
}

// Timing helper shared with the buildah path, so both produce the same phase
// markers and the page has one parser rather than two.
export const PHASE_HELPER =
  '__phase() { echo "== $1 +$(( $(date +%s) - ${__t0:-0} ))s =="; }\n'

const ROOTFS = '/rootfs'

// Whiteouts are how an overlay layer records a deletion. Extracting layers with
// plain tar leaves them as literal files, so they have to be applied by hand.
// Opaque markers go first: they clear a directory that later entries may repopulate.
const applyWhiteouts =
  "find " + ROOTFS + " -name '.wh..wh..opq' 2>/dev/null | while read -r marker; do\n" +
  '  target=$(dirname "$marker"); rm -rf "$target"/* 2>/dev/null; rm -f "$marker"\n' +
  'done\n' +
  "find " + ROOTFS + " -name '.wh.*' 2>/dev/null | while read -r marker; do\n" +
  '  rm -rf "$(dirname "$marker")/$(basename "$marker" | cut -c5-)" "$marker" 2>/dev/null\n' +
  'done\n'

// Env and working directory are applied inside the chroot rather than around it,
// because busybox chroot passes neither and the rootfs may not have `env`.
const insideRootfs = (plan: ChrootPlan, command: string, inPlace: boolean): string => {
  const prelude = plan.env
    .map(([key, value]) => 'export ' + key + '=' + shellQuote(value) + '; ')
    .join('')
  // TODO(FAST-PATH-TODO.md): mkdir the workdir and let a real failure fail the
  // build. `|| true` currently hides a missing directory and runs in / instead.
  const cd = plan.workdir ? 'cd ' + shellQuote(plan.workdir) + ' 2>/dev/null || true; ' : ''
  const body = shellQuote(prelude + cd + command)
  // In-place, the guest's own root IS the base image, so there is nothing to
  // chroot into and no copy to make first.
  return inPlace ? '/bin/sh -c ' + body : 'chroot ' + ROOTFS + ' /bin/sh -c ' + body
}

// The image's own Entrypoint/Cmd apply when the Dockerfile overrides neither, so
// the caller resolves them and passes the result.
export const launchCommand = (
  plan: ChrootPlan,
  fallback: { entrypoint?: string[]; cmd?: string[] },
): string => {
  const toParts = (value: string[] | string | null, fromImage?: string[]): string[] | string | null =>
    value ?? (fromImage && fromImage.length ? fromImage : null)

  const entrypoint = toParts(plan.entrypoint, fallback.entrypoint)
  const cmd = toParts(plan.cmd, fallback.cmd)

  const render = (value: string[] | string): string =>
    Array.isArray(value) ? value.map(shellQuote).join(' ') : value

  if (entrypoint && cmd) return render(entrypoint) + ' ' + render(cmd)
  if (entrypoint) return render(entrypoint)
  if (cmd) return render(cmd)
  return '/bin/sh'
}

export type ChrootScriptOptions = {
  plan: ChrootPlan
  // Empty when the guest already IS the base image, in which case there is
  // nothing to transfer and the build runs directly in the guest's own root.
  layers: LayerRef[]
  // Resolved from the base image config, for when the Dockerfile sets neither.
  imageDefaults: { entrypoint?: string[]; cmd?: string[] }
  // Emitted once the container is up, so the page can stop waiting.
  readyMarker: string
  failMarker: string
}

export const chrootBuildScript = (options: ChrootScriptOptions): string => {
  const { plan, layers, imageDefaults, readyMarker, failMarker } = options
  // No layers means the guest was built from this very base image, so the build
  // runs in its own root. That removes the entire transfer, which is the
  // dominant cost of every build measured so far (317s for 3.4MB on riscv64,
  // against under a second for the build steps themselves).
  const inPlace = layers.length === 0
  const parts: string[] = []

  parts.push('__t0=$(date +%s)\n')
  parts.push(PHASE_HELPER)
  parts.push('set -e\n')
  if (inPlace) parts.push('__phase ' + shellQuote('base image is the guest, nothing to transfer') + '\n')
  else parts.push('mkdir -p ' + ROOTFS + '\n')

  layers.forEach((layer, index) => {
    const label = 'layer ' + (index + 1) + '/' + layers.length
    // Fetch and extract are deliberately separate rather than piped. Piping is
    // one pass fewer, but it merges the two costs into a single unsplittable
    // number, and they have completely different fixes: a slow bridge is a
    // networking problem, a slow gunzip is an emulation problem. Measure first.
    const tmp = '/tmp/layer' + index + '.tar.gz'
    parts.push('__phase ' + shellQuote('fetch ' + label + ' (' + layer.bytes + ' bytes)') + '\n')
    parts.push(
      "wget -q -O " + tmp + " 'http://" + GATEWAY + '/img/' + encodeURIComponent(layer.key) + "'" +
      ' || { echo ' + failMarker + '; exit 1; }\n',
    )
    parts.push('__phase ' + shellQuote('extract ' + label) + '\n')
    parts.push(
      'tar -xzf ' + tmp + ' -C ' + ROOTFS +
      ' || { echo ' + failMarker + '; exit 1; }\n',
    )
    parts.push('rm -f ' + tmp + '\n')
  })

  if (layers.length > 1) parts.push(applyWhiteouts)
  if (!inPlace) {
    parts.push('__phase ' + shellQuote('base image ready') + '\n')
    // RUN steps reach the network through the same gateway the page uses.
    parts.push('mkdir -p ' + ROOTFS + '/etc\n')
    parts.push("printf 'nameserver " + GATEWAY.split(':')[0] + "\\n' > " + ROOTFS + '/etc/resolv.conf\n')
  }

  plan.runs.forEach((command, index) => {
    const step = 'RUN ' + (index + 1) + '/' + plan.runs.length
    parts.push('__phase ' + shellQuote(step + ': ' + command.slice(0, 120)) + '\n')
    parts.push(insideRootfs(plan, command, inPlace) + ' || { echo ' + failMarker + '; exit 1; }\n')
  })

  parts.push('__phase ' + shellQuote('build complete') + '\n')
  parts.push('echo ' + readyMarker + '\n')
  parts.push('__phase ' + shellQuote('starting container') + '\n')
  parts.push(insideRootfs(plan, launchCommand(plan, imageDefaults), inPlace) + '\n')

  return parts.join('')
}
