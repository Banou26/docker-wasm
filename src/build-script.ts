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
//
// The generated script is the whole build. It runs unattended in a guest with no
// debugger attached, so a mistake here is a quiet wrong answer rather than a
// visible failure, and the shape of the emitted shell matters as much as what it
// says. Two rules follow from that: state the real builder had at a given point
// is replayed at that point rather than applied once up front, and anything the
// page can resolve is resolved in the page rather than guessed at in the guest.

import type { BuildStep, ChrootPlan, EnvBinding, WordPart } from './dockerfile'
import { shellQuote } from './dockerfile'
import type { LayerOps } from './layers'

// Where the page's artifact bridge answers inside the guest.
export const GATEWAY = '192.168.127.1:9090'

export type LayerRef = {
  // Key the page registered the layer bytes under, in application order.
  key: string
  bytes: number
  // What has to happen to the rootfs before and after this layer lands. Absent
  // for a layer nothing was scanned for, which is treated as a plain extract.
  ops?: LayerOps
}

// Resolved from the base image config. `env` entries are `KEY=value` exactly as
// the config carries them, so they are literal rather than expandable.
export type ImageDefaults = {
  env?: string[]
  workdir?: string
  entrypoint?: string[]
  cmd?: string[]
}

// Timing helper shared with the buildah path, so both produce the same phase
// markers and the page has one parser rather than two. The number it prints
// comes from the guest's clock and is not trustworthy (an emulated guest does
// not necessarily advance it while blocked on I/O); the page times the arrival
// of the marker itself, which is what the status view shows.
export const PHASE_HELPER =
  '__phase() { echo "== $1 +$(( $(date +%s) - ${__t0:-0} ))s =="; }\n'

const ROOTFS = '/rootfs'

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

// A word the shell will expand exactly as far as docker would: variable
// references survive, and everything else, including the `$` docker was told to
// treat literally, does not become one.
export const renderWord = (parts: WordPart[]): string => {
  if (parts.length === 0) return '""'
  const literal = (value: string): string => value.replace(/([\\$`"])/g, '\\$1')
  return '"' + parts
    .map((part) => (part.kind === 'literal'
      ? literal(part.value)
      : '${' + part.expression.replace(/"/g, '\\"') + '}'))
    .join('') + '"'
}

const rootPath = (path: string): string => shellQuote(ROOTFS + '/' + path)

// Every `rm` a layer needs, emitted before the layer is extracted rather than
// after. Before is what makes an opaque directory correct: the layer's own
// contents land on the cleared directory, where sweeping afterwards would take
// them with it.
const layerPreparation = (ops: LayerOps): string[] => {
  const lines: string[] = []
  for (const path of ops.removals) lines.push('rm -rf ' + rootPath(path))
  for (const path of ops.emptied) {
    const target = path ? rootPath(path) : shellQuote(ROOTFS)
    lines.push('rm -rf ' + target + ' && mkdir -p ' + target)
  }
  return lines
}

// The state docker had in effect at one position, replayed as shell.
//
// Replayed from the base image every time rather than carried between steps,
// because each step is its own `sh -c` and inherits nothing from the last. That
// is also what makes it correct: the list is the prefix of assignments up to
// this instruction, so an ENV written below a RUN cannot reach it.
const preludeLines = (
  defaults: ImageDefaults,
  env: EnvBinding[],
  workdirs: WordPart[][],
): string[] => {
  const lines: string[] = []
  for (const entry of defaults.env ?? []) {
    const split = entry.indexOf('=')
    if (split <= 0) continue
    const key = entry.slice(0, split)
    if (!IDENTIFIER.test(key)) continue
    lines.push('export ' + key + '=' + shellQuote(entry.slice(split + 1)))
  }
  // The image's own working directory, which is where docker starts. `chroot`
  // lands in the new root, but an in-place build starts wherever the guest's
  // shell was, so stating it is what keeps the two paths identical.
  const base = defaults.workdir && defaults.workdir.trim() ? defaults.workdir.trim() : '/'
  lines.push('cd ' + shellQuote(base) + ' || exit 1')

  for (const binding of env) {
    if (!IDENTIFIER.test(binding.key)) continue
    lines.push('export ' + binding.key + '=' + renderWord(binding.value))
  }
  for (const directory of workdirs) {
    const rendered = renderWord(directory)
    // docker creates a WORKDIR that does not exist, and a `cd` that fails is a
    // failed build rather than a step that quietly runs somewhere else.
    lines.push('mkdir -p ' + rendered + ' && cd ' + rendered + ' || exit 1')
  }
  return lines
}

// Env and working directory are applied inside the chroot rather than around it,
// because busybox chroot passes neither and the rootfs may not have `env`.
const insideRootfs = (body: string, inPlace: boolean): string =>
  // In-place, the guest's own root IS the base image, so there is nothing to
  // chroot into and no copy to make first.
  (inPlace ? '/bin/sh -c ' : 'chroot ' + ROOTFS + ' /bin/sh -c ') + shellQuote(body)

// The image's own Entrypoint/Cmd apply when the Dockerfile overrides neither, so
// the caller resolves them and passes the result.
export const launchCommand = (plan: ChrootPlan, fallback: ImageDefaults): string => {
  const isEmptyExec = (value: string[] | string | null): boolean =>
    Array.isArray(value) && value.length === 0
  const fromImage = (value: string[] | undefined): string[] | null =>
    value && value.length > 0 ? value : null

  const setsEntrypoint = plan.entrypoint !== null
  const entrypoint: string[] | string | null = setsEntrypoint
    ? (isEmptyExec(plan.entrypoint) ? null : plan.entrypoint)
    : fromImage(fallback.entrypoint)

  const cmd: string[] | string | null = plan.cmd !== null
    ? (isEmptyExec(plan.cmd) ? null : plan.cmd)
    // Setting ENTRYPOINT clears a CMD inherited from the base image: docker
    // documents it, and appending the inherited one instead launches something
    // the Dockerfile never asked for.
    : setsEntrypoint ? null
      : fromImage(fallback.cmd)

  // A shell form ENTRYPOINT becomes `sh -c <string>`, which accepts no further
  // arguments, so docker drops CMD entirely rather than appending it.
  if (typeof entrypoint === 'string') return entrypoint

  const asArgv = (value: string[] | string): string =>
    Array.isArray(value)
      ? value.map(shellQuote).join(' ')
      // A shell form CMD after an exec form ENTRYPOINT is passed as docker
      // stores it, three arguments rather than a line of shell.
      : '/bin/sh -c ' + shellQuote(value)

  if (entrypoint && cmd) return asArgv(entrypoint) + ' ' + asArgv(cmd)
  if (entrypoint) return asArgv(entrypoint)
  // On its own, a shell form CMD is a line of shell, and this already runs in one.
  if (cmd) return Array.isArray(cmd) ? asArgv(cmd) : cmd
  return '/bin/sh'
}

// `/dev` is not part of an image layer, so a chroot has none unless one is made.
// Without it `/dev/null` is created as a regular file by the first redirect,
// accumulates everything written to it, and ships inside the built image;
// `apt-get` refuses to run at all.
const DEVICE_SETUP =
  'mkdir -p ' + ROOTFS + '/dev ' + ROOTFS + '/proc ' + ROOTFS + '/sys ' + ROOTFS + '/tmp\n' +
  'chmod 1777 ' + ROOTFS + '/tmp\n' +
  'mount -o bind /dev ' + ROOTFS + '/dev 2>/dev/null || {\n' +
  '  mknod -m 666 ' + ROOTFS + '/dev/null c 1 3 2>/dev/null\n' +
  '  mknod -m 666 ' + ROOTFS + '/dev/zero c 1 5 2>/dev/null\n' +
  '  mknod -m 666 ' + ROOTFS + '/dev/full c 1 7 2>/dev/null\n' +
  '  mknod -m 444 ' + ROOTFS + '/dev/random c 1 8 2>/dev/null\n' +
  '  mknod -m 444 ' + ROOTFS + '/dev/urandom c 1 9 2>/dev/null\n' +
  '  mknod -m 666 ' + ROOTFS + '/dev/tty c 5 0 2>/dev/null\n' +
  '  true\n' +
  '}\n' +
  'mount -t proc none ' + ROOTFS + '/proc 2>/dev/null || true\n' +
  'mount -t sysfs none ' + ROOTFS + '/sys 2>/dev/null || true\n'

export type ChrootScriptOptions = {
  plan: ChrootPlan
  // Empty when the guest already IS the base image, in which case there is
  // nothing to transfer and the build runs directly in the guest's own root.
  layers: LayerRef[]
  // Resolved from the base image config, for everything the Dockerfile leaves
  // unset. Its `env` carries PATH on most images, so dropping it means every
  // RUN step runs with whatever the chroot's `/bin/sh` happens to default to.
  imageDefaults: ImageDefaults
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
  const orFail = ' || { echo ' + failMarker + '; exit 1; }\n'
  const phase = (label: string): string => '__phase ' + shellQuote(label) + '\n'

  parts.push('__t0=$(date +%s)\n')
  parts.push(PHASE_HELPER)
  parts.push('set -e\n')
  if (inPlace) parts.push(phase('base image is the guest, nothing to transfer'))
  else parts.push('mkdir -p ' + ROOTFS + '\n')

  layers.forEach((layer, index) => {
    const label = 'layer ' + (index + 1) + '/' + layers.length
    // Fetch and extract are deliberately separate rather than piped. Piping is
    // one pass fewer, but it merges the two costs into a single unsplittable
    // number, and they have completely different fixes: a slow bridge is a
    // networking problem, a slow gunzip is an emulation problem. Measure first.
    const tmp = '/tmp/layer' + index + '.tar'
    parts.push(phase('fetch ' + label + ' (' + layer.bytes + ' bytes)'))
    parts.push(
      "wget -q -O " + tmp + " 'http://" + GATEWAY + '/img/' + encodeURIComponent(layer.key) + "'" +
      orFail,
    )

    const preparation = layer.ops ? layerPreparation(layer.ops) : []
    if (preparation.length > 0) {
      parts.push(phase('apply ' + label + ' deletions (' + preparation.length + ')'))
      for (const line of preparation) parts.push(line + '\n')
    }

    parts.push(phase('extract ' + label))
    const flag = layer.ops?.compression === 'none' ? '-xf' : '-xzf'
    parts.push('tar ' + flag + ' ' + tmp + ' -C ' + ROOTFS + orFail)
    // The markers are overlay bookkeeping, not image content, and their effect
    // was already applied above.
    for (const marker of layer.ops?.markers ?? []) parts.push('rm -f ' + rootPath(marker) + '\n')
    parts.push('rm -f ' + tmp + '\n')
  })

  if (!inPlace) {
    parts.push(phase('base image ready'))
    parts.push(DEVICE_SETUP)
    // RUN steps reach the network through the same gateway the page uses.
    parts.push('mkdir -p ' + ROOTFS + '/etc\n')
    parts.push("printf 'nameserver " + GATEWAY.split(':')[0] + "\\n' > " + ROOTFS + '/etc/resolv.conf\n')
  }

  const body = (step: BuildStep | null, command: string): string =>
    [
      ...preludeLines(
        imageDefaults,
        step ? step.env : plan.env,
        step ? step.workdirs : plan.workdirs,
      ),
      command,
    ].join('\n')

  plan.steps.forEach((step, index) => {
    const label = 'RUN ' + (index + 1) + '/' + plan.steps.length +
      ' (line ' + step.line + '): ' + step.command.slice(0, 120)
    parts.push(phase(label))
    parts.push(insideRootfs(body(step, step.command), inPlace) + orFail)
  })

  parts.push(phase('build complete'))
  parts.push('echo ' + readyMarker + '\n')
  parts.push(phase('starting container'))
  // `exec` so the launched process is the container rather than a child of a
  // shell that has nothing left to do.
  parts.push(insideRootfs(body(null, 'exec ' + launchCommand(plan, imageDefaults)), inPlace) + '\n')

  return parts.join('')
}
