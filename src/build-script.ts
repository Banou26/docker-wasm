// What comes back is not an OCI image: `src/dockerfile.ts` decides what this fast path can handle.

import type { BuildStep, ChrootPlan, EnvBinding, WordPart } from './dockerfile'
import { shellQuote } from './dockerfile'
import type { LayerOps } from './layers'

// Where the page's artifact bridge answers inside the guest, fixed by the Go netstack (netstack.go ImageHTTPPort) and rewritten to a local port by test/fast-path.
export const GATEWAY = '192.168.127.1:9090'

export type LayerRef = {
  key: string
  bytes: number
  ops?: LayerOps
}

export type ImageDefaults = {
  // `KEY=value` exactly as the image config carries them, so they are literal rather than expandable.
  env?: string[]
  workdir?: string
  entrypoint?: string[]
  cmd?: string[]
}

// Duplicated verbatim as `phaseHelper` in main.ts's buildah path; both must emit the same `== label +Ns ==` text, because the page has one marker parser rather than two.
export const PHASE_HELPER =
  '__phase() { echo "== $1 +$(( $(date +%s) - ${__t0:-0} ))s =="; }\n'

const ROOTFS = '/rootfs'

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

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

// Emitted before the layer is extracted: sweeping afterwards would take the layer's own contents with it.
const layerPreparation = (ops: LayerOps): string[] => {
  const lines: string[] = []
  for (const path of ops.removals) lines.push('rm -rf ' + rootPath(path))
  for (const path of ops.emptied) {
    const target = path ? rootPath(path) : shellQuote(ROOTFS)
    lines.push('rm -rf ' + target + ' && mkdir -p ' + target)
  }
  return lines
}

// Replayed from the base image every time, because each step is its own `sh -c` and inherits nothing from the last.
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
  // The image's own working directory, stated because `chroot` lands in the new root but an in-place build starts wherever the guest's shell was, and stating it keeps the two paths identical.
  const base = defaults.workdir && defaults.workdir.trim() ? defaults.workdir.trim() : '/'
  lines.push('cd ' + shellQuote(base) + ' || exit 1')

  for (const binding of env) {
    if (!IDENTIFIER.test(binding.key)) continue
    lines.push('export ' + binding.key + '=' + renderWord(binding.value))
  }
  for (const directory of workdirs) {
    const rendered = renderWord(directory)
    lines.push('mkdir -p ' + rendered + ' && cd ' + rendered + ' || exit 1')
  }
  return lines
}

// Env and working directory are applied inside the chroot, because busybox chroot passes neither.
const insideRootfs = (body: string, inPlace: boolean): string =>
  (inPlace ? '/bin/sh -c ' : 'chroot ' + ROOTFS + ' /bin/sh -c ') + shellQuote(body)

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
    // Setting ENTRYPOINT clears a CMD inherited from the base image, as docker documents.
    : setsEntrypoint ? null
      : fromImage(fallback.cmd)

  // A shell form ENTRYPOINT becomes `sh -c <string>`, which accepts no arguments, so docker drops CMD entirely.
  if (typeof entrypoint === 'string') return entrypoint

  const asArgv = (value: string[] | string): string =>
    Array.isArray(value)
      ? value.map(shellQuote).join(' ')
      : '/bin/sh -c ' + shellQuote(value)

  if (entrypoint && cmd) return asArgv(entrypoint) + ' ' + asArgv(cmd)
  if (entrypoint) return asArgv(entrypoint)
  if (cmd) return Array.isArray(cmd) ? asArgv(cmd) : cmd
  return '/bin/sh'
}

// `/dev` is not part of an image layer, so without this the first redirect creates `/dev/null` as a regular file.
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
  // Empty when the guest already IS the base image, so the build runs directly in the guest's own root.
  layers: LayerRef[]
  // Its `env` carries PATH on most images, so dropping it means every RUN step runs with whatever the chroot's `/bin/sh` happens to default to.
  imageDefaults: ImageDefaults
  // Emitted once the container is up, so the page can stop waiting; main.ts's ConsoleTail scans for exactly these strings.
  readyMarker: string
  failMarker: string
}

export const chrootBuildScript = (options: ChrootScriptOptions): string => {
  const { plan, layers, imageDefaults, readyMarker, failMarker } = options
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
    // Fetch and extract are deliberately separate rather than piped, so the two costs stay separately measurable.
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
    for (const marker of layer.ops?.markers ?? []) parts.push('rm -f ' + rootPath(marker) + '\n')
    parts.push('rm -f ' + tmp + '\n')
  })

  if (!inPlace) {
    parts.push(phase('base image ready'))
    parts.push(DEVICE_SETUP)
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
  parts.push(insideRootfs(body(null, 'exec ' + launchCommand(plan, imageDefaults)), inPlace) + '\n')

  return parts.join('')
}
