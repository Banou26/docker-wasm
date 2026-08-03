import { init, Terminal, FitAddon } from 'ghostty-web'

import { createContainer, type ArtifactCache, type Container } from './lib'
import { pullImage, pullRootfs, dockerfileFromRefs, type PulledRootfs } from './registry'
import { b64decodeUtf8, HASH_KEY_DOCKERFILE, QUERY_PARAMS, withWasmAssetVersion } from './shared'
import { BUILDERS, DEFAULT_BUILDER_ARCH, GUESTS, sameImage, type BuilderArch } from './builder'
import { planBuild, type ChrootPlan } from './dockerfile'
import { scanLayers, type LayerOps } from './layers'
import { emitBuildEvent } from './build-events'
import { chrootBuildScript, GATEWAY, type ImageDefaults, type LayerRef } from './build-script'
import { isPresetWasmURL, matchPreset, PRESET_WASM_PATHS } from './presets'

const timings: Record<string, number> = {}
;(window as typeof window & { dockerWasmTimings?: Record<string, number> }).dockerWasmTimings = timings
const mark = (name: string): void => {
  if (timings[name] !== undefined) return
  timings[name] = Math.round(performance.now())
  performance.mark('docker-wasm:' + name)
  console.info('[timing] ' + name + ': ' + timings[name] + ' ms from navigation')
}
mark('runtime-script-ready')

let stage = 0
let failed = false
let running: Container | null = null

const setStage = (index: number, message: string, tone: 'normal' | 'error' = 'normal'): void => {
  if (failed && tone !== 'error') return
  if (index < stage) {
    if (tone !== 'error') return
    index = stage
  }
  stage = index
  if (tone === 'error') failed = true
  emitBuildEvent({ type: 'stage', index, message, tone })
  const state = document.getElementById('runtime-state')
  if (state) {
    state.textContent = message
    state.closest<HTMLElement>('.session-title')?.setAttribute('data-tone', tone)
  }
  document.querySelectorAll<HTMLElement>('[data-runtime-stage]').forEach((node) => {
    const position = Number(node.dataset.runtimeStage)
    node.classList.toggle('is-done', position < index)
    node.classList.toggle('is-active', position === index)
  })
  const progress = document.getElementById('runtime-progress') as HTMLElement | null
  if (progress) progress.style.width = ((index + 1) * 25) + '%'
}

type PublishSpec = { guestPort: number }

const getPublishSpec = (query: URLSearchParams): PublishSpec | null => {
  const value = query.get(QUERY_PARAMS.publish)
  if (value === null) return null
  const match = value.match(/^tcp:(\d+)$/)
  const guestPort = Number(match?.[1])
  if (!match || !Number.isInteger(guestPort) || guestPort < 1 || guestPort > 65535) {
    throw new Error('publish must use tcp:<port>, with a port between 1 and 65535')
  }
  return { guestPort }
}

const resolveAsset = (path: string): string =>
  new URL(withWasmAssetVersion(path), location.href).toString()

// The guest console is a TTY, so the tail is kept as plain text with these escape sequences stripped.
const ANSI = /\u001B(?:\[[0-9;?]*[ -/]*[@-~]|[()][A-Za-z0-9]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|[=>NOM78])/g

class ConsoleTail {
  private text = ''
  private decoder = new TextDecoder()
  // The rendered terminal is a canvas, so this plain-text tail is the only thing the page or a test can read back.
  readonly markers = {
    buildOk: false,
    buildFailed: false,
    runFailed: false,
    serviceReady: false,
    serviceFailed: false,
  }

  // The guest's own `+Ns` must not be compared across guests: only this side has a real clock.
  readonly phases: Array<{ label: string; atMs: number; sinceMs: number }> = []
  private lastPhaseAt = performance.now()

  read (): string {
    return this.text
  }

  private recordPhases (chunk: string): void {
    for (const match of chunk.matchAll(/== (.+?) \+\d+s ==/g)) {
      const atMs = Math.round(performance.now())
      const sinceMs = Math.round(atMs - this.lastPhaseAt)
      this.phases.push({ label: match[1]!, atMs, sinceMs })
      this.lastPhaseAt = atMs
      emitBuildEvent({ type: 'phase', label: match[1]!, atMs, sinceMs })
      console.info(
        '[phase] ' + match[1] + ': took ' + (sinceMs / 1000).toFixed(1) + 's' +
        ' (wall clock, ' + (atMs / 1000).toFixed(1) + 's from navigation)',
      )
    }
  }

  push (bytes: Uint8Array): void {
    const chunk = this.decoder.decode(bytes, { stream: true }).replace(ANSI, '')
    this.recordPhases(chunk)
    this.text = (this.text + chunk).slice(-4096)
    this.markers.buildOk ||= chunk.includes('__FKN_BUILD_OK__')
    this.markers.buildFailed ||= chunk.includes('__FKN_BUILD_FAILED__')
    this.markers.runFailed ||= chunk.includes('__FKN_RUN_FAILED__')
    this.markers.serviceReady ||= chunk.includes('__FKN_SERVICE_READY__')
    this.markers.serviceFailed ||= chunk.includes('__FKN_SERVICE_FAILED__')
  }

  atPrompt (): boolean {
    return /[#$]\s*$/.test(this.text.replace(/\r/g, '').trimEnd())
  }

  atContainerPrompt (): boolean {
    return /\/\s*#\s*$/.test(this.text.replace(/\r/g, '').trimEnd())
  }
}

type BrowserConsoleTone = 'command' | 'comment' | 'route' | 'header' | 'success' | 'body' | 'error'

let builderArch: BuilderArch = DEFAULT_BUILDER_ARCH

const main = async (): Promise<void> => {
  const query = new URLSearchParams(location.search)
  const requestedArch = query.get(QUERY_PARAMS.arch)
  if (requestedArch === 'riscv64' || requestedArch === 'amd64') builderArch = requestedArch
  else if (requestedArch) throw new Error('arch must be riscv64 or amd64 when provided')
  const publishSpec = getPublishSpec(query)
  const runParam = query.get(QUERY_PARAMS.run)
  if (runParam !== null && runParam !== 'default') {
    throw new Error('run must be default when provided')
  }
  const serviceMode = publishSpec !== null && runParam === 'default'
  if ((publishSpec !== null) !== (runParam === 'default')) {
    throw new Error('publish=tcp:<port> and run=default must be used together')
  }

  const hashMatch = location.hash.match(new RegExp('(?:^#|&)' + HASH_KEY_DOCKERFILE + '=([^&]+)'))
  let dockerfileB64: string | null = null
  let dockerfileText: string | null = null
  if (hashMatch?.[1]) {
    try {
      dockerfileB64 = decodeURIComponent(hashMatch[1])
      dockerfileText = b64decodeUtf8(dockerfileB64)
    } catch {
      throw new Error('Dockerfile hash is not valid base64')
    }
  }
  if (serviceMode && dockerfileText === null) {
    throw new Error('virtual service mode requires a Dockerfile')
  }

  const preset = dockerfileText === null
    ? null
    : matchPreset(dockerfileText, publishSpec?.guestPort ?? null)

  const buildPlan = (preset || dockerfileText === null) ? null : planBuild(dockerfileText)
  const guest = GUESTS[buildPlan?.engine === 'chroot' ? 'runner' : 'builder'][builderArch]

  if (buildPlan) {
    const chroot = buildPlan.engine === 'chroot' ? buildPlan : null
    emitBuildEvent({
      type: 'plan',
      engine: buildPlan.engine,
      reason: buildPlan.engine === 'buildah'
        ? buildPlan.reason
        : 'Every instruction is one the fast path can run',
      base: chroot?.base ?? null,
      inPlace: chroot !== null && guest.baseImage !== undefined &&
        sameImage(chroot.base, guest.baseImage),
      guest: { kind: guest.kind, arch: guest.arch, downloadBytes: guest.approximateDownloadBytes },
      steps: chroot?.steps.map((step) => ({ line: step.line, command: step.command })) ?? [],
    })
  }

  const servicePanel = document.getElementById('service-panel')
  const serviceEndpoint = document.getElementById('service-endpoint')
  const serviceResult = document.getElementById('service-result') as HTMLOutputElement | null
  const serviceProbe = document.getElementById('service-probe') as HTMLButtonElement | null
  const browserConsole = document.getElementById('browser-console')
  const browserConsoleState = document.getElementById('browser-console-state')
  const browserConsoleOutput = document.getElementById('browser-console-output')

  if (serviceMode) {
    document.getElementById('runtime-trace-target')!.textContent = 'to service'
    document.getElementById('runtime-final-title')!.textContent = 'Run service'
    document.getElementById('runtime-final-copy')!.textContent = 'HTTP through virtual TCP'
    if (servicePanel) {
      servicePanel.hidden = false
      servicePanel.closest('.terminal-frame')?.classList.add('has-service')
    }
    if (browserConsole) browserConsole.hidden = false
  }

  const setConsoleState = (label: string, tone: 'waiting' | 'fetching' | 'success' | 'error'): void => {
    if (!browserConsoleState) return
    browserConsoleState.textContent = label
    browserConsoleState.dataset.tone = tone
  }
  const writeConsole = (prompt: string, message: string, tone: BrowserConsoleTone): void => {
    if (!browserConsoleOutput) return
    const line = document.createElement('div')
    line.className = 'browser-console-line is-' + tone
    const marker = document.createElement('span')
    marker.textContent = prompt
    const code = document.createElement('code')
    code.textContent = message
    line.append(marker, code)
    browserConsoleOutput.append(line)
    browserConsoleOutput.scrollTop = browserConsoleOutput.scrollHeight
  }

  setStage(0, 'Loading terminal runtime')
  await init()

  const terminal = new Terminal({
    cols: 80,
    rows: 24,
    fontSize: innerWidth < 640 ? 12 : 14,
    cursorBlink: true,
    theme: {
      background: '#090a08',
      foreground: '#e8eadf',
      cursor: '#bdff38',
      selectionBackground: '#3548ff',
    },
  })
  ;(window as { xterm?: unknown }).xterm = terminal   // driver introspection
  const terminalElement = document.getElementById('terminal')
  if (!terminalElement) throw new Error('#terminal not found')
  terminal.open(terminalElement)

  const fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  fitAddon.fit()
  fitAddon.observeResize()
  // The addon drops observer events during its short resize lock, so refit once or the bottom rows stay clipped.
  setTimeout(() => fitAddon.fit(), 75)
  mark('terminal-ready')

  const imageURL = preset
    ? resolveAsset(PRESET_WASM_PATHS[preset])
    : (() => {
        const requested = query.get(QUERY_PARAMS.wasmUrl)
        const legacyId = query.get(QUERY_PARAMS.wasm)
        if (requested) {
          // A preset URL with an edited Dockerfile no longer matches the dedicated runtime, so use the plan's guest.
          return isPresetWasmURL(requested)
            ? resolveAsset(guest.wasmPath)
            : new URL(requested, location.href).toString()
        }
        if (legacyId) return new URL('/wasm/' + legacyId + '/out.wasm', location.href).toString()
        if (buildPlan) return resolveAsset(guest.wasmPath)
        return resolveAsset('/out.wasm')
      })()

  const artifacts: ArtifactCache = new Map()
  const tail = new ConsoleTail()
  ;(window as typeof window & {
    dockerWasmConsole?: () => string
    dockerWasmPhases?: () => Array<{ label: string; atMs: number; sinceMs: number }>
  }).dockerWasmConsole = () => tail.read()
  ;(window as typeof window & {
    dockerWasmPhases?: () => Array<{ label: string; atMs: number; sinceMs: number }>
  }).dockerWasmPhases = () => tail.phases

  setStage(0, 'Booting Linux guest')
  const container = createContainer({
    image: imageURL,
    netstackImage: resolveAsset('/c2w-webvpn-proxy.wasm'),
    ports: publishSpec ? [publishSpec.guestPort] : [],
    artifacts,
    columns: terminal.cols,
    rows: terminal.rows,
    onLog: (bytes) => {
      terminal.write(bytes)
      tail.push(bytes)
    },
    onStatus: (status) => {
      if (status.phase === 'compiled' && status.source === 'guest') mark('wasm-ready')
      if (status.phase === 'running' && status.source === 'guest') mark('guest-started')
      if (status.phase === 'failed') setStage(stage, 'Runtime failed: ' + status.error.message, 'error')
    },
  })
  running = container
  addEventListener('pagehide', () => { void container.stop() }, { once: true })

  terminal.onData((data) => container.write(data))
  terminal.onResize(({ cols, rows }) => container.resize(cols, rows))

  await container.ready
  mark('workers-started')

  if (publishSpec) {
    const port = container.ports[0]
    if (port && serviceEndpoint) {
      serviceEndpoint.textContent = port.host + ':' + port.port + ' -> guest :' + port.guestPort
    }
    if (port && browserConsoleOutput) {
      browserConsoleOutput.replaceChildren()
      writeConsole('//', 'Live code running in this page\'s browser main thread.', 'comment')
      writeConsole('//', 'container.fetch goes over an in-process TCP route, not the network.', 'comment')
      writeConsole('>', 'const container = createContainer({ image, ports: [' + port.guestPort + '] })', 'command')
      writeConsole('->', 'Docker guest :' + port.guestPort + ' via ' + port.origin, 'route')
      setConsoleState('Port ready', 'waiting')
    }
    mark('virtual-listener-ready')
  }

  let requestCount = 0
  let probing = false

  const sendRequest = async (): Promise<void> => {
    if (!serviceResult || probing) return
    probing = true
    if (serviceProbe) serviceProbe.disabled = true
    const startedAt = performance.now()
    requestCount++
    if (requestCount > 1) writeConsole('//', 'Request ' + requestCount, 'comment')
    writeConsole('>', 'response = await container.fetch("/")', 'command')
    setConsoleState('Fetching', 'fetching')
    serviceResult.textContent = requestCount === 1 ? 'Waiting for the guest service' : 'Sending GET /'
    try {
      const response = await container.fetch('/')
      const elapsedMs = Math.round(performance.now() - startedAt)
      mark('guest-service-ready')
      mark('first-http-response')
      serviceResult.textContent = response.status +
        (response.statusText ? ' ' + response.statusText : '') + ' / ' + elapsedMs + ' ms'
      writeConsole('<', 'HTTP ' + response.status +
        (response.statusText ? ' ' + response.statusText : '') + ' (' + elapsedMs + ' ms)', 'success')
      response.headers.forEach((value, name) => writeConsole('', name + ': ' + value, 'header'))
      const body = (await response.text()).slice(0, 2_000)
      const contentType = (response.headers.get('content-type') || '').toLowerCase()
      let expression = 'await response.text()'
      let rendered = JSON.stringify(body)
      if (contentType.includes('application/json')) {
        try {
          expression = 'await response.json()'
          rendered = JSON.stringify(JSON.parse(body), null, 2)
        } catch {}
      }
      writeConsole('>', expression, 'command')
      writeConsole('<', rendered, 'body')
      setConsoleState(String(response.status), 'success')
      setStage(3, 'HTTP service reachable through the in-process route')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      serviceResult.textContent = 'Request failed: ' + message
      writeConsole('!', message, 'error')
      setConsoleState('Failed', 'error')
      if (requestCount === 1) setStage(3, 'HTTP request did not complete')
    } finally {
      probing = false
      if (serviceProbe) serviceProbe.disabled = false
    }
  }

  if (serviceProbe) serviceProbe.addEventListener('click', () => { void sendRequest() })

  const watch = (check: () => boolean, onHit: () => void, intervalMs = 400): void => {
    const timer = setInterval(() => {
      if (!check()) return
      clearInterval(timer)
      onHit()
    }, intervalMs)
  }

  if (preset) {
    mark('preset-runtime-started')
    if (serviceMode) {
      setStage(1, 'Dedicated HTTP runtime selected')
      setStage(2, 'Starting HTTP service')
      if (serviceProbe) serviceProbe.disabled = false
      void sendRequest()
      return
    }
    setStage(1, 'Dedicated shell runtime selected')
    setStage(2, 'Starting container shell')
    watch(() => tail.atPrompt(), () => {
      mark('guest-shell-ready')
      mark('container-shell-ready')
      setStage(3, 'Container shell ready')
    })
    return
  }

  if (dockerfileText === null || dockerfileB64 === null) {
    watch(() => tail.atPrompt(), () => {
      mark('guest-shell-ready')
      setStage(3, 'Linux shell ready')
    })
    return
  }

  if (buildPlan?.engine === 'chroot') {
    await runChrootBuild({
      container, artifacts, tail, plan: buildPlan, platform: guest.platform,
      guestBaseImage: guest.baseImage,
      guestBaseImageConfig: guest.baseImageConfig,
      publishSpec, serviceMode, setConsoleState, writeConsole, sendRequest, watch,
    })
    return
  }

  await runBuilder({
    container,
    artifacts,
    tail,
    terminal,
    dockerfileText,
    dockerfileB64,
    publishSpec,
    serviceMode,
    serviceResult,
    serviceProbe,
    setConsoleState,
    writeConsole,
    sendRequest,
    watch,
  })
}

const runChrootBuild = async (context: {
  container: Container
  artifacts: ArtifactCache
  tail: ConsoleTail
  plan: ChrootPlan
  platform: { os: string; arch: string }
  guestBaseImage?: string
  guestBaseImageConfig?: ImageDefaults
  publishSpec: PublishSpec | null
  serviceMode: boolean
  setConsoleState: (label: string, tone: 'waiting' | 'fetching' | 'success' | 'error') => void
  writeConsole: (prompt: string, message: string, tone: BrowserConsoleTone) => void
  sendRequest: () => Promise<void>
  watch: (check: () => boolean, onHit: () => void, intervalMs?: number) => void
}): Promise<void> => {
  const { container, artifacts, tail, plan, platform, serviceMode, watch, sendRequest } = context

  // Skipping the transfer is the whole point: it dominates a build at 3.4 MB through the artifact bridge measured at 317s on riscv64, against under a second for the build steps.
  const inPlace = context.guestBaseImage !== undefined &&
    sameImage(plan.base, context.guestBaseImage)

  let layers: LayerRef[] = []
  let imageDefaults: ImageDefaults = context.guestBaseImageConfig ?? {}

  if (inPlace) {
    setStage(1, plan.base + ' is already this guest, skipping the pull')
    mark('base-images-ready')
  } else {
    setStage(1, 'Pulling ' + plan.base)
    const rootfs: PulledRootfs = await pullRootfs(plan.base, {
      platform,
      onLog: (line) => console.log('[registry] ' + plan.base + ': ' + line),
      onProgress: (progress) => emitBuildEvent({
        type: 'pull',
        ref: progress.ref,
        bytesReceived: progress.bytesReceived,
        bytesTotal: progress.bytesTotal,
        layersDone: progress.layersDone,
        layersTotal: progress.layersTotal,
      }),
    }).catch((error: unknown) => {
      setStage(1, 'Image pull failed: ' + String(error), 'error')
      throw error
    })
    mark('base-images-ready')
    imageDefaults = {
      env: rootfs.config.Env,
      workdir: rootfs.config.WorkingDir,
      entrypoint: rootfs.config.Entrypoint,
      cmd: rootfs.config.Cmd,
    }

    // Overlay deletions must be resolved here, with the layers still separate: after extraction they are one directory.
    const ops = await scanLayers(rootfs.layers).catch((error: unknown) => {
      console.warn('[layers] scan failed, extracting without deletions: ' + String(error))
      return [] as LayerOps[]
    })

    layers = rootfs.layers.map((bytes, index) => {
      const key = '__fkn_layer_' + index + '__'
      artifacts.set(key, { promise: null, bytes })
      return { key, bytes: bytes.length, ops: ops[index] }
    })
  }

  setStage(2, 'Building in Linux')
  const script = chrootBuildScript({
    plan,
    layers,
    imageDefaults,
    readyMarker: '__FKN_BUILD_' + 'OK__',
    failMarker: '__FKN_BUILD_' + 'FAILED__',
  })

  const scriptRef = '__fkn_runtime_build_script__'
  artifacts.set(scriptRef, { promise: null, bytes: new TextEncoder().encode(script) })

  watch(() => tail.atPrompt(), () => {
    mark('guest-shell-ready')
    container.write(
      "wget -q -O /tmp/fkn-build.sh 'http://" + GATEWAY + '/img/' + encodeURIComponent(scriptRef) +
      "' && sh /tmp/fkn-build.sh\n",
    )
    mark('build-script-sent')
  })

  watch(() => tail.markers.buildOk || tail.markers.buildFailed, () => {
    if (tail.markers.buildFailed) {
      setStage(2, 'Dockerfile build failed', 'error')
      emitBuildEvent({ type: 'finished', ok: false, message: 'The build failed inside the guest' })
      return
    }
    mark('image-built')
    setStage(3, serviceMode ? 'Starting service' : 'Container ready')
    emitBuildEvent({
      type: 'finished',
      ok: true,
      message: serviceMode ? 'Service starting' : 'Container ready',
    })
    if (serviceMode) void sendRequest()
  })
}

type BuilderContext = {
  container: Container
  artifacts: ArtifactCache
  tail: ConsoleTail
  terminal: Terminal
  dockerfileText: string
  dockerfileB64: string
  publishSpec: PublishSpec | null
  serviceMode: boolean
  serviceResult: HTMLOutputElement | null
  serviceProbe: HTMLButtonElement | null
  setConsoleState: (label: string, tone: 'waiting' | 'fetching' | 'success' | 'error') => void
  writeConsole: (prompt: string, message: string, tone: BrowserConsoleTone) => void
  sendRequest: () => Promise<void>
  watch: (check: () => boolean, onHit: () => void, intervalMs?: number) => void
}

const runBuilder = async (context: BuilderContext): Promise<void> => {
  const {
    container, artifacts, tail, terminal, dockerfileText, dockerfileB64,
    publishSpec, serviceMode, serviceResult, serviceProbe,
    setConsoleState, writeConsole, sendRequest, watch,
  } = context

  let padded = dockerfileB64
  while (padded.length % 4) padded += '='

  const refs = dockerfileFromRefs(dockerfileText)
  const instructions: string[] = []
  const parsed = dockerfileText.split('\n').every((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return true
    const instruction = /^([A-Za-z]+)/.exec(trimmed)?.[1]?.toUpperCase()
    if (instruction) instructions.push(instruction)
    return instruction !== undefined
  })
  const reuseBuildContainer = parsed && instructions.join(',') === 'FROM,EXPOSE,CMD'

  if (refs.length === 0) mark('base-images-ready')
  setStage(1, refs.length === 0
    ? 'No base image pull required'
    : 'Pulling ' + refs.length + ' base image' + (refs.length === 1 ? '' : 's'))

  let readyRefs = 0
  for (const ref of refs) {
    if (artifacts.has(ref)) continue
    const entry: { promise: Promise<Uint8Array> | null; bytes: Uint8Array | null } =
      { promise: null, bytes: null }
    artifacts.set(ref, entry)
    entry.promise = pullImage(ref, {
      platform: BUILDERS[builderArch].platform,
      onLog: (line) => console.log('[registry] ' + ref + ': ' + line),
    })
      .then((bytes) => { entry.bytes = bytes; return bytes })
    entry.promise.then(() => {
      readyRefs++
      if (readyRefs === refs.length) {
        mark('base-images-ready')
        setStage(1, 'Base image ready, Linux booting')
      }
    }, (error: unknown) => {
      setStage(1, 'Image pull failed: ' + String(error), 'error')
    })
  }

  const storageConf =
    '[storage]\\n' +
    'driver = "overlay"\\n' +
    'graphroot = "/var/lib/containers/storage"\\n' +
    'runroot = "/run/containers/storage"\\n' +
    '[storage.options.overlay]\\n' +
    'mountopt = "nodev"\\n'

  let loadBlock = ''
  for (const ref of refs) {
    const encoded = encodeURIComponent(ref)
    const safe = ref.replace(/[^A-Za-z0-9._-]/g, '_')
    loadBlock +=
      '__phase "fetch ' + ref + '"\n' +
      "wget -q 'http://192.168.127.1:9090/img/" + encoded + "' -O /tmp/" + safe + ".tar || { echo wget-failed; exit 1; }\n" +
      '__phase "fetched ' + ref + ' $(/bin/busybox wc -c < /tmp/' + safe + '.tar) bytes"\n' +
      'buildah pull docker-archive:/tmp/' + safe + '.tar\n' +
      '__phase "loaded ' + ref + '"\n' +
      'rm -f /tmp/' + safe + '.tar\n'
  }

  // The build runs in a `sh -eu` heredoc, so both scripts define __phase; only the outer one sets and exports the clock.
  const phaseHelper =
    '__phase() { echo "== $1 +$(( $(date +%s) - ${__t0:-0} ))s =="; }\n'

  const buildCommands =
    phaseHelper +
    'mkdir -p /work /var/lib/containers/storage /run/containers/storage /etc/containers && cd /work\n' +
    "printf 'nameserver 192.168.127.1\\n' > /etc/resolv.conf\n" +
    "printf '" + storageConf + "' > /etc/containers/storage.conf\n" +
    loadBlock +
    "echo '" + padded + "' | base64 -d > Dockerfile\n" +
    '__phase "buildah build"\n' +
    'buildah bud' + (reuseBuildContainer ? ' --layers --rm=false' : '') +
    ' --isolation chroot --network host --pull=never -t userimg .\n' +
    '__phase "build complete"\n'

  const defaultCommandSetup = serviceMode
    ? 'cmdfile=/tmp/fkn-image-command\n' +
      'buildah inspect --type image --format \'{{range .Docker.Config.Entrypoint}}{{printf "%s%c" . 0}}{{end}}{{range .Docker.Config.Cmd}}{{printf "%s%c" . 0}}{{end}}\' "$target_image" > "$cmdfile"\n' +
      'set --\n' +
      'while IFS= read -r -d \'\' arg; do set -- "$@" "$arg"; done < "$cmdfile"\n' +
      '[ "$#" -gt 0 ] || { echo "image has no default command" >&2; echo __FKN_SERVICE_"FAILED"__; exit 1; }\n'
    : ''
  const containerCommand = serviceMode ? ' "$@"' : ' /bin/sh'
  const createContainerLine = reuseBuildContainer
    ? 'build_containers=$(buildah containers -q); ' +
      'ctr=$(printf "%s\\n" "$build_containers" | /bin/busybox tail -n 1); ' +
      '( sleep 30; for candidate in $build_containers; do ' +
      '[ "$candidate" = "$ctr" ] || buildah rm "$candidate" >/dev/null 2>&1 || true; done ) & ' +
      '[ -n "$ctr" ] || ctr=$(buildah from "$target_image")'
    : 'ctr=$(buildah from "$target_image")'

  const launch = serviceMode && publishSpec
    ? '  ' + createContainerLine + ' || { echo __FKN_SERVICE_"FAILED"__; exit 1; }\n' +
      '  printf "== image command =="; printf " <%s>" "$@"; printf "\\n"\n' +
      '  (\n' +
      '    attempt=0\n' +
      '    deadline=$(($(date +%s) + 60))\n' +
      '    until { printf \'GET / HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n\'; sleep 1; } | /bin/busybox nc -w 2 127.0.0.1 ' + publishSpec.guestPort + ' 2>/dev/null | /bin/busybox head -n 1 | /bin/busybox grep -Eq \'^HTTP/[0-9]+\\.[0-9]+ [0-9][0-9][0-9]([[:space:]]|$)\'; do\n' +
      '      attempt=$((attempt + 1))\n' +
      '      if [ $((attempt % 10)) -eq 0 ]; then echo "waiting for guest service ($attempt attempts)"; fi\n' +
      '      if [ "$(date +%s)" -ge "$deadline" ]; then\n' +
      '        echo __FKN_SERVICE_"FAILED"__\n' +
      '        pids=$(/bin/busybox pidof buildah || true)\n' +
      '        [ -z "$pids" ] || kill $pids\n' +
      '        exit 1\n' +
      '      fi\n' +
      '      sleep 1\n' +
      '    done\n' +
      '    echo __FKN_SERVICE_"READY"__\n' +
      '  ) &\n' +
      '  readiness_pid=$!\n' +
      '  buildah run --network host --terminal --env TERM=dumb "$ctr"' + containerCommand + '\n' +
      '  status=$?\n' +
      '  kill "$readiness_pid" 2>/dev/null || true\n' +
      '  wait "$readiness_pid" 2>/dev/null || true\n' +
      '  echo __FKN_SERVICE_"FAILED"__\n' +
      '  exit "$status"\n'
    : '  ' + createContainerLine + ' || { echo __FKN_RUN_"FAILED"__; exit 1; }\n' +
      '  if buildah run --network host --terminal --env TERM=dumb "$ctr"' + containerCommand + '; then\n' +
      '    exit 0\n' +
      '  else\n' +
      '    status=$?\n' +
      '    echo __FKN_RUN_"FAILED"__\n' +
      '    exit "$status"\n' +
      '  fi\n'

  const script =
    '__t0=$(date +%s)\n' +
    'export __t0\n' +
    phaseHelper +
    "if sh -eu <<'FKN_BUILD'\n" + buildCommands +
    'FKN_BUILD\n' +
    'then\n' +
    '  echo __FKN_BUILD_"OK"__\n' +
    '  __phase "running container"\n' +
    '  target_image=userimg\n' +
    defaultCommandSetup +
    launch +
    'else\n' +
    '  echo __FKN_BUILD_"FAILED"__\n' +
    'fi\n'

  // The script goes through the artifact bridge rather than the console: a multi-kilobyte paste exceeds the PTY buffer.
  const scriptRef = '__fkn_runtime_build_script__'
  artifacts.set(scriptRef, { promise: null, bytes: new TextEncoder().encode(script) })
  const launcher = "if wget -q 'http://192.168.127.1:9090/img/" + encodeURIComponent(scriptRef) +
    "' -O /tmp/fkn-build.sh; then sh /tmp/fkn-build.sh; else echo __FKN_BUILD_\"FAILED\"__; fi\n"

  watch(() => tail.atPrompt(), () => {
    mark('guest-shell-ready')
    setStage(2, 'Building Dockerfile in Linux')
    terminal.paste(launcher)
    mark('build-script-sent')
  }, 700)

  let probeStarted = false
  const buildTimer = setInterval(() => {
    const markers = tail.markers
    if (markers.buildFailed || markers.runFailed || markers.serviceFailed) {
      clearInterval(buildTimer)
      if (serviceProbe) serviceProbe.disabled = true
      if (markers.serviceFailed && serviceResult) {
        serviceResult.textContent = probeStarted
          ? 'The image service exited'
          : 'The image command did not open guest port ' + publishSpec?.guestPort
      }
      if (serviceMode) {
        setConsoleState(markers.buildFailed ? 'Build failed' : 'Service stopped', 'error')
        writeConsole('!', markers.buildFailed
          ? 'Dockerfile build failed before the HTTP request.'
          : probeStarted
            ? 'The Docker HTTP service stopped and its route closed.'
            : 'The Docker HTTP service did not open guest port ' + publishSpec?.guestPort + '.',
        'error')
      }
      setStage(markers.buildFailed ? 2 : 3,
        markers.buildFailed
          ? 'Dockerfile build failed'
          : markers.runFailed
            ? 'Container failed to start'
            : probeStarted ? 'Image service stopped' : 'Image service failed to start',
        'error')
      return
    }
    if (!markers.buildOk) return
    mark('image-built')
    if (serviceMode) {
      if (probeStarted) return
      setStage(3, 'Starting virtual HTTP service')
      if (serviceResult) serviceResult.textContent = 'Waiting for guest service on :' + publishSpec?.guestPort
      if (!markers.serviceReady) return
      mark('guest-service-ready')
      probeStarted = true
      if (serviceProbe) serviceProbe.disabled = false
      void sendRequest()
      return
    }
    const shellReady = tail.atContainerPrompt()
    setStage(3, shellReady ? 'Container shell ready' : 'Starting container shell')
    if (shellReady) {
      mark('container-shell-ready')
      clearInterval(buildTimer)
      if (serviceProbe) serviceProbe.disabled = false
    }
  }, 700)

  void container
}

main().catch((error: unknown) => {
  void running?.stop()
  setStage(0, 'Runtime failed: ' + String(error instanceof Error ? error.message : error), 'error')
  console.error('runtime bootstrap failed', error)
})
