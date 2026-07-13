// Runtime entry. The page's <script type="module"> from index.html.
//
// Bootstraps:
//   1. credentialless-iframes shim (so the @fkn/lib RPC iframe under our COEP
//      doesn't get blocked at injection time).
//   2. ghostty-web (canvas terminal, WASM VT parser from Ghostty).
//   3. xterm-pty (terminal-agnostic PTY shim; pairs with the c2w worker's
//      TtyClient over postMessage).
//   4. The c2w WASI worker (classic worker at /worker.js) and the netstack-
//      proxy worker (classic worker at /webvpn-stack-worker.js) when
//      ?net=webvpn / browser / delegate.
//   5. Auto-paste path: if the URL hash carries `#dockerfile=<base64>`, kick
//      off Docker Hub pulls for each FROM ref immediately, then type a build
//      script into the shell when its prompt appears.

import { init, Terminal, FitAddon } from 'ghostty-web'
import {
  openpty, Termios, TtyServer,
  ISTRIP, INLCR, IGNCR, ICRNL, IXON,
  OPOST,
  ECHO, ECHONL, ICANON, ISIG, IEXTEN,
} from 'xterm-pty'
import type { ImageCache, Netstack, VirtualTCPPort } from './webvpn-netstack'
import type { NetMode } from './shared'

import { newStack } from './stack'
import { createWebvpnNetstack } from './webvpn-netstack'
import { pullImage, dockerfileFromRefs } from './registry'
import { b64decodeUtf8, HASH_KEY_DOCKERFILE, QUERY_PARAMS, withWasmAssetVersion } from './shared'

// Loaded into globals by /ws-delegate.js (kept as a static asset under public/).
declare const delegate: (worker: Worker, image: string, address: string) => (msg: MessageEvent) => void

let currentRuntimeStage = 0
let runtimeFailed = false
let closeRuntimeResources: (() => void) | null = null

const runtimeTimings: Record<string, number> = {}
;(window as typeof window & { dockerWasmTimings?: Record<string, number> }).dockerWasmTimings = runtimeTimings
const markRuntimeTiming = (name: string): void => {
  if (runtimeTimings[name] !== undefined) return
  const elapsedMs = Math.round(performance.now())
  runtimeTimings[name] = elapsedMs
  performance.mark('docker-wasm:' + name)
  console.info('[timing] ' + name + ': ' + elapsedMs + ' ms from navigation')
}
markRuntimeTiming('runtime-script-ready')

type PublishSpec = { guestPort: number }

type VirtualHTTPResponse = {
  status: number
  statusText: string
  httpVersion: string
  headers: Array<[string, string]>
  body: string
  elapsedMs: number
}

type BrowserConsoleTone = 'command' | 'comment' | 'route' | 'header' | 'success' | 'body' | 'error'

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

const fetchContainer = async (url: URL): Promise<VirtualHTTPResponse> => {
  const { request } = await import('@fkn/lib/http')
  const startedAt = performance.now()
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      callback()
    }
    const req = request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: Number(url.port || 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: { Connection: 'close' },
    }, (response) => {
      const decoder = new TextDecoder()
      let body = ''
      response.on('data', (chunk: Uint8Array | string) => {
        if (body.length >= 2_000) return
        body += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      })
      response.on('end', () => finish(() => {
        const headers: Array<[string, string]> = []
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          headers.push([response.rawHeaders[index] || '', response.rawHeaders[index + 1] || ''])
        }
        resolve({
          status: response.statusCode || 0,
          statusText: response.statusMessage || '',
          httpVersion: response.httpVersion,
          headers,
          body: (body + decoder.decode()).slice(0, 2_000),
          elapsedMs: Math.round(performance.now() - startedAt),
        })
      }))
      response.on('error', (error) => finish(() => reject(error)))
    })
    req.on('error', (error) => finish(() => reject(error)))
    timer = setTimeout(() => {
      req.destroy()
      finish(() => reject(new Error('HTTP request timed out')))
    }, 5_000)
    req.end()
  })
}

const setRuntimeStage = (stage: number, message: string, tone: 'normal' | 'error' = 'normal'): void => {
  if (runtimeFailed && tone !== 'error') return
  if (stage < currentRuntimeStage) {
    if (tone !== 'error') return
    stage = currentRuntimeStage
  }
  currentRuntimeStage = stage
  if (tone === 'error') runtimeFailed = true
  const state = document.getElementById('runtime-state')
  if (state) {
    state.textContent = message
    state.closest<HTMLElement>('.session-title')?.setAttribute('data-tone', tone)
  }
  document.querySelectorAll<HTMLElement>('[data-runtime-stage]').forEach((element) => {
    const index = Number(element.dataset.runtimeStage)
    element.classList.toggle('is-done', index < stage)
    element.classList.toggle('is-active', index === stage)
  })
  const progress = document.getElementById('runtime-progress') as HTMLElement | null
  if (progress) progress.style.width = ((stage + 1) * 25) + '%'
}

// The credentialless-iframes shim is in index.html (synchronous inline script,
// runs before the module so the patch is in place when @fkn/lib creates its
// RPC iframe).

const getNetParam = (): { mode: NetMode; param: string | undefined } | null => {
  const qs = new URLSearchParams(location.search)
  const value = qs.get(QUERY_PARAMS.net)
  if (!value) return null
  const [mode, param] = value.split('=', 2)
  if (mode !== 'delegate' && mode !== 'browser' && mode !== 'webvpn') return null
  return { mode, param }
}

const assertWasmAsset = async (url: string, label: string): Promise<void> => {
  const response = await fetch(url, { method: 'HEAD', credentials: 'same-origin' })
  const type = response.headers.get('content-type') || 'unknown content type'
  if (!response.ok || !type.toLowerCase().includes('application/wasm')) {
    throw new Error(label + ' is unavailable at ' + url + ' (' + response.status + ', ' + type + ')')
  }
}

const main = async () => {
  const queryParams = new URLSearchParams(location.search)
  const publishSpec = getPublishSpec(queryParams)
  const runParam = queryParams.get(QUERY_PARAMS.run)
  if (runParam !== null && runParam !== 'default') {
    throw new Error('run must be default when provided')
  }
  const runImageDefault = runParam === 'default'
  if ((publishSpec !== null) !== runImageDefault) {
    throw new Error('publish=tcp:<port> and run=default must be used together')
  }
  const serviceMode = publishSpec !== null && runImageDefault
  const netParam = getNetParam()
  if (publishSpec && netParam?.mode !== 'webvpn') {
    throw new Error('virtual guest ports require ?net=webvpn')
  }
  const dockerfileMatch = location.hash.match(new RegExp('(?:^#|&)' + HASH_KEY_DOCKERFILE + '=([^&]+)'))
  let dockerfileB64: string | null = null
  let dockerfileText: string | null = null
  if (dockerfileMatch?.[1]) {
    try {
      dockerfileB64 = decodeURIComponent(dockerfileMatch[1])
      dockerfileText = b64decodeUtf8(dockerfileB64)
    } catch {
      throw new Error('Dockerfile hash is not valid base64')
    }
  }
  if (serviceMode && dockerfileText === null) {
    throw new Error('virtual service mode requires a Dockerfile')
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

  setRuntimeStage(0, 'Loading terminal runtime')
  await init()

  const xterm = new Terminal({
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
  // xterm-pty 0.9.4's master.activate calls e.onBinary(handler); ghostty-web
  // doesn't expose onBinary (no use case in a canvas terminal). Shim it.
  if (!(xterm as { onBinary?: unknown }).onBinary) {
    (xterm as unknown as { onBinary: (cb: unknown) => { dispose(): void } })
      .onBinary = () => ({ dispose () {} })
  }
  ;(window as { xterm?: unknown }).xterm = xterm   // driver introspection
  const terminalEl = document.getElementById('terminal')
  if (!terminalEl) throw new Error('#terminal not found')
  xterm.open(terminalEl)

  // Resize the terminal to fill its container. Each xterm.resize(cols, rows)
  // fires master.onResize -> slave.notifyResize, which pushes SIGWINCH (with
  // the new winsize) up to the c2w guest.
  const fitAddon = new FitAddon()
  xterm.loadAddon(fitAddon)
  fitAddon.fit()
  fitAddon.observeResize()
  // FitAddon drops observer events during its short resize lock. Refit once
  // after the final service layout has settled so no canvas rows are clipped.
  setTimeout(() => fitAddon.fit(), 75)
  markRuntimeTiming('terminal-ready')

  const { master, slave } = openpty()
  const runtimeMarkers = {
    buildOk: false,
    buildFailed: false,
    serviceReady: false,
    serviceFailed: false,
  }
  const markerDecoder = new TextDecoder()
  let markerTail = ''
  master.onWrite(([bytes]: [Uint8Array, () => void]) => {
    const output = markerTail + markerDecoder.decode(bytes, { stream: true })
    runtimeMarkers.buildOk ||= output.includes('__FKN_BUILD_OK__')
    runtimeMarkers.buildFailed ||= output.includes('__FKN_BUILD_FAILED__')
    runtimeMarkers.serviceReady ||= output.includes('__FKN_SERVICE_READY__')
    runtimeMarkers.serviceFailed ||= output.includes('__FKN_SERVICE_FAILED__')
    markerTail = output.slice(-256)
  })
  const termios = slave.ioctl('TCGETS')
  // Pass through bytes verbatim - the c2w guest does its own line discipline.
  const iflag = termios.iflag & ~(ISTRIP | INLCR | IGNCR | ICRNL | IXON)
  const oflag = termios.oflag & ~OPOST
  const lflag = termios.lflag & ~(ECHO | ECHONL | ICANON | ISIG | IEXTEN)
  slave.ioctl('TCSETS', new Termios(iflag, oflag, termios.cflag, lflag, termios.cc))
  xterm.loadAddon(master as Parameters<typeof xterm.loadAddon>[0])

  const wasmUrl = queryParams.get(QUERY_PARAMS.wasmUrl)
  const wasmId = queryParams.get(QUERY_PARAMS.wasm)
  const resolveWasmAsset = (path: string): string =>
    new URL(withWasmAssetVersion(path), location.href).toString()
  const workerImage = wasmUrl
    ? new URL(wasmUrl, location.href).toString()
    : wasmId
      ? new URL('/wasm/' + wasmId + '/out.wasm', location.href).toString()
      : resolveWasmAsset('/out.wasm')

  const stackImage = netParam?.mode === 'browser'
    ? resolveWasmAsset('/c2w-net-proxy.wasm')
    : netParam?.mode === 'webvpn'
      ? resolveWasmAsset('/c2w-webvpn-proxy.wasm')
      : null
  await Promise.all([
    assertWasmAsset(workerImage, 'Guest image'),
    ...(stackImage ? [assertWasmAsset(stackImage, 'Network stack')] : []),
  ])
  markRuntimeTiming('wasm-assets-validated')
  setRuntimeStage(0, 'Booting Linux guest')

  // Artifact cache populated below from #dockerfile=<b64> in the URL hash.
  // createWebvpnNetstack reads from it when the proxy worker requests an
  // image_size or image_chunk for a FROM ref or generated build script.
  const imageCache: ImageCache = new Map()

  // c2w-webvpn lazy init: build the netstack the first time a webvpn_* arrives.
  let webvpn: Netstack | null = null
  const ensureWebvpn = (): Netstack | null => {
    if (webvpn) return webvpn
    webvpn = createWebvpnNetstack({ imageCache })
    return webvpn
  }

  const closeWebvpn = (): void => {
    if (webvpn) void webvpn.close().catch((error) => console.log('[webvpn] close failed: ' + error))
  }
  closeRuntimeResources = closeWebvpn
  addEventListener('pagehide', closeWebvpn, { once: true })

  let virtualPortPromise: Promise<VirtualTCPPort> | null = null
  let probeInFlight = false
  let browserRequestCount = 0
  const setBrowserConsoleState = (label: string, tone: 'waiting' | 'fetching' | 'success' | 'error'): void => {
    if (!browserConsoleState) return
    browserConsoleState.textContent = label
    browserConsoleState.dataset.tone = tone
  }
  const writeBrowserConsole = (prompt: string, message: string, tone: BrowserConsoleTone): void => {
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
  const getVirtualHTTPURL = (virtualPort: VirtualTCPPort): URL => {
    const host = virtualPort.virtualHost.includes(':')
      ? '[' + virtualPort.virtualHost + ']'
      : virtualPort.virtualHost
    return new URL('http://' + host + ':' + virtualPort.virtualPort + '/')
  }
  const initializeBrowserConsole = (virtualPort: VirtualTCPPort): void => {
    if (!browserConsoleOutput) return
    const url = getVirtualHTTPURL(virtualPort)
    browserConsoleOutput.replaceChildren()
    writeBrowserConsole('//', 'Live code running in this page\'s browser main thread.', 'comment')
    writeBrowserConsole('//', 'fetchContainer uses @fkn/lib/http over FKN virtual TCP.', 'comment')
    writeBrowserConsole('>', 'const url = ' + JSON.stringify(url.href), 'command')
    writeBrowserConsole('>', 'let response', 'command')
    writeBrowserConsole('->', 'Docker guest :' + virtualPort.guestPort, 'route')
    setBrowserConsoleState('Port ready', 'waiting')
  }
  const closeVirtualPort = (): void => {
    if (virtualPortPromise) void virtualPortPromise.then((virtualPort) => virtualPort.close()).catch(() => {})
  }

  if (publishSpec) {
    const netstack = ensureWebvpn()
    if (!netstack) throw new Error('FKN netstack is unavailable')
    virtualPortPromise = netstack.listenTCP(publishSpec.guestPort).then((virtualPort) => {
      if (serviceEndpoint) {
        serviceEndpoint.textContent = virtualPort.virtualHost + ':' + virtualPort.virtualPort +
          ' -> guest :' + virtualPort.guestPort
      }
      initializeBrowserConsole(virtualPort)
      markRuntimeTiming('virtual-listener-ready')
      return virtualPort
    }).catch((error) => {
      if (serviceResult) serviceResult.textContent = 'Virtual listener failed: ' + error
      setBrowserConsoleState('Failed', 'error')
      writeBrowserConsole('!', 'Virtual listener failed: ' + error, 'error')
      setRuntimeStage(currentRuntimeStage, 'Virtual listener failed', 'error')
      throw error
    })
    await virtualPortPromise
  }

  const worker = new Worker('/worker.js' + location.search)

  const probeService = async (retry: boolean): Promise<void> => {
    if (!virtualPortPromise || !serviceResult || !serviceProbe || probeInFlight) return
    probeInFlight = true
    serviceProbe.disabled = true
    let lastError: unknown = new Error('service did not respond')
    try {
      const virtualPort = await virtualPortPromise
      const url = getVirtualHTTPURL(virtualPort)
      const attempts = retry ? 8 : 1
      for (let attempt = 0; attempt < attempts; attempt++) {
        browserRequestCount++
        if (browserRequestCount > 1) {
          writeBrowserConsole('//', 'Request ' + browserRequestCount, 'comment')
        }
        writeBrowserConsole('>', 'response = await fetchContainer(url)', 'command')
        writeBrowserConsole('->', 'GET ' + url.pathname + ' -> Docker guest :' + virtualPort.guestPort, 'route')
        setBrowserConsoleState('Fetching', 'fetching')
        try {
          serviceResult.textContent = attempt === 0 ? 'Sending GET /' : 'Waiting for guest service, retry ' + attempt
          const response = await fetchContainer(url)
          markRuntimeTiming('first-http-response')
          serviceResult.textContent = response.status + (response.statusText ? ' ' + response.statusText : '') +
            ' / ' + response.elapsedMs + ' ms'
          const statusLine = 'HTTP/' + response.httpVersion + ' ' + response.status +
            (response.statusText ? ' ' + response.statusText : '') + ' (' + response.elapsedMs + ' ms)'
          writeBrowserConsole('<', statusLine, 'success')
          for (const [name, value] of response.headers) {
            writeBrowserConsole('', name.toLowerCase() + ': ' + value, 'header')
          }
          const contentType = response.headers
            .find(([name]) => name.toLowerCase() === 'content-type')?.[1].toLowerCase() || ''
          let bodyExpression = 'response.body'
          let bodyOutput = JSON.stringify(response.body)
          if (contentType.includes('application/json')) {
            try {
              bodyExpression = 'JSON.parse(response.body)'
              bodyOutput = JSON.stringify(JSON.parse(response.body), null, 2)
            } catch {}
          }
          writeBrowserConsole('>', bodyExpression, 'command')
          writeBrowserConsole('<', bodyOutput, 'body')
          setBrowserConsoleState(response.status + (response.statusText ? ' ' + response.statusText : ''), 'success')
          setRuntimeStage(3, 'HTTP service reachable through FKN in-process')
          return
        } catch (error) {
          lastError = error
          writeBrowserConsole('!', String(error), 'error')
          if (attempt + 1 < attempts) {
            setBrowserConsoleState('Retrying', 'waiting')
            await new Promise((resolve) => setTimeout(resolve, 2_000))
          }
        }
      }
      throw lastError
    } catch (error) {
      serviceResult.textContent = 'Request failed: ' + error
      setBrowserConsoleState('Fetch failed', 'error')
      if (retry) setRuntimeStage(3, 'HTTP request did not complete')
    } finally {
      probeInFlight = false
      serviceProbe.disabled = false
    }
  }

  if (serviceProbe) serviceProbe.addEventListener('click', () => { void probeService(false) })

  let nwStack: ((msg: MessageEvent) => void) | undefined
  if (netParam) {
    if (netParam.mode === 'delegate') {
      if (!netParam.param) throw new Error('?net=delegate requires =<address>')
      nwStack = delegate(worker, workerImage, netParam.param)
    } else if (netParam.mode === 'browser') {
      nwStack = newStack(
        worker, workerImage,
        new Worker('/stack-worker.js' + location.search),
        resolveWasmAsset('/c2w-net-proxy.wasm'),
        ensureWebvpn,
      )
    } else if (netParam.mode === 'webvpn') {
      nwStack = newStack(
        worker, workerImage,
        new Worker('/webvpn-stack-worker.js' + location.search),
        resolveWasmAsset('/c2w-webvpn-proxy.wasm'),
        ensureWebvpn,
      )
    }
  }
  if (!nwStack) {
    worker.postMessage({ type: 'init', imagename: workerImage })
  }
  new TtyServer(slave).start(worker as unknown as Parameters<TtyServer['start']>[0], nwStack)
  markRuntimeTiming('workers-started')

  const terminalTail = (count: number): string => {
    return [xterm.buffer.normal, xterm.buffer.alternate]
      .map((buf) => {
        const cursorRow = buf.baseY + buf.cursorY
        let text = ''
        for (let y = Math.max(0, cursorRow - count); y <= cursorRow; y++) {
          const line = buf.getLine(y)
          if (line) text += line.translateToString(true) + '\n'
        }
        return text.trimEnd()
      })
      .filter(Boolean)
      .join('\n')
  }

  // In-browser dockerfile playground: if location.hash carries a base64
  // Dockerfile, kick off the FROM-image pulls in JS right now (so the netstack
  // proxy's gateway HTTP server has bytes ready by the time the guest wget's
  // them), then run the generated build script when the shell prompt appears.
  if (dockerfileText === null || dockerfileB64 === null) {
    const promptTimer = setInterval(() => {
      if (!/# *$/.test(terminalTail(2).trimEnd())) return
      clearInterval(promptTimer)
      markRuntimeTiming('guest-shell-ready')
      setRuntimeStage(3, 'Linux shell ready')
    }, 500)
    return
  }

  // Re-pad for the in-guest busybox base64 -d which is strict about padding.
  let dockerfileB64Padded = dockerfileB64
  while (dockerfileB64Padded.length % 4) dockerfileB64Padded += '='

  const refs = dockerfileFromRefs(dockerfileText)
  // The compact HTTP preset can run Buildah's final working container without
  // creating another container from the completed image.
  const instructions: string[] = []
  const parsedInstructions = dockerfileText.split('\n').every((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return true
    const instruction = /^([A-Za-z]+)/.exec(trimmed)?.[1]?.toUpperCase()
    if (instruction) instructions.push(instruction)
    return instruction !== undefined
  })
  const canReuseBuildContainer = parsedInstructions && instructions.join(',') === 'FROM,EXPOSE,CMD'
  if (refs.length === 0) markRuntimeTiming('base-images-ready')
  setRuntimeStage(1, refs.length === 0
    ? 'No base image pull required'
    : 'Pulling ' + refs.length + ' base image' + (refs.length === 1 ? '' : 's'))
  let readyRefs = 0
  for (const ref of refs) {
    if (imageCache.has(ref)) continue
    const entry: { promise: Promise<Uint8Array> | null; bytes: Uint8Array | null } =
      { promise: null, bytes: null }
    imageCache.set(ref, entry)
    console.log('[registry] pulling ' + ref)
    entry.promise = pullImage(ref, { onLog: (s) => console.log('[registry] ' + ref + ': ' + s) })
      .then((b) => { entry.bytes = b; return b })
    entry.promise.then(() => {
      readyRefs++
      if (readyRefs === refs.length) {
        markRuntimeTiming('base-images-ready')
        setRuntimeStage(1, 'Base image ready, Linux booting')
      }
    }, (error) => {
      closeVirtualPort()
      setRuntimeStage(1, 'Image pull failed: ' + error, 'error')
    })
  }

  const storageConf =
    '[storage]\\n' +
    'driver = "overlay"\\n' +
    'graphroot = "/var/lib/containers/storage"\\n' +
    'runroot = "/run/containers/storage"\\n' +
    '[storage.options.overlay]\\n' +
    'mountopt = "nodev"\\n'

  let pullBlock = ''
  for (const ref of refs) {
    const enc = encodeURIComponent(ref)
    const safe = ref.replace(/[^A-Za-z0-9._-]/g, '_')
    pullBlock +=
      'echo "== pull ' + ref + ' =="\n' +
      "wget -q 'http://192.168.127.1:9090/img/" + enc + "' -O /tmp/" + safe + ".tar || { echo wget-failed; exit 1; }\n" +
      'buildah pull docker-archive:/tmp/' + safe + '.tar\n' +
      'rm -f /tmp/' + safe + '.tar\n'
  }
  const buildCommands =
    'mkdir -p /work /var/lib/containers/storage /run/containers/storage /etc/containers && cd /work\n' +
    "printf 'nameserver 192.168.127.1\\n' > /etc/resolv.conf\n" +
    "printf '" + storageConf + "' > /etc/containers/storage.conf\n" +
    pullBlock +
    "echo '" + dockerfileB64Padded + "' | base64 -d > Dockerfile\n" +
    'echo == buildah build ==\n' +
    'buildah bud' + (canReuseBuildContainer ? ' --layers --rm=false' : '') +
    ' --isolation chroot --network host --pull=never -t userimg .\n' +
    'echo == build complete ==\n'
  const defaultCommandSetup = runImageDefault
    ? 'cmdfile=/tmp/fkn-image-command\n' +
      'buildah inspect --type image --format \'{{range .Docker.Config.Entrypoint}}{{printf "%s%c" . 0}}{{end}}{{range .Docker.Config.Cmd}}{{printf "%s%c" . 0}}{{end}}\' userimg > "$cmdfile"\n' +
      'set --\n' +
      'while IFS= read -r -d \'\' arg; do set -- "$@" "$arg"; done < "$cmdfile"\n' +
      '[ "$#" -gt 0 ] || { echo "image has no default command" >&2; echo __FKN_SERVICE_"FAILED"__; exit 1; }\n'
    : ''
  const containerCommand = runImageDefault ? ' "$@"' : ' /bin/sh'
  const createContainer = canReuseBuildContainer
    ? 'build_containers=$(buildah containers -q); ' +
      'ctr=$(printf "%s\\n" "$build_containers" | /bin/busybox tail -n 1); ' +
      '( sleep 30; for candidate in $build_containers; do ' +
      '[ "$candidate" = "$ctr" ] || buildah rm "$candidate" >/dev/null 2>&1 || true; done ) & ' +
      '[ -n "$ctr" ] || ctr=$(buildah from userimg)'
    : 'ctr=$(buildah from userimg)'
  const containerLaunch = serviceMode && publishSpec
    ? '  ' + createContainer + ' || { echo __FKN_SERVICE_"FAILED"__; exit 1; }\n' +
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
    : '  ' + createContainer + ' && exec buildah run --network host --terminal --env TERM=dumb "$ctr"' + containerCommand + '\n'
  const script =
    "if sh -eu <<'FKN_BUILD'\n" + buildCommands +
    'FKN_BUILD\n' +
    'then\n' +
    '  echo __FKN_BUILD_"OK"__\n' +
    '  echo == running container ==\n' +
    defaultCommandSetup +
    containerLaunch +
    'else\n' +
    '  echo __FKN_BUILD_"FAILED"__\n' +
    'fi\n'

  // Serve the generated script through the local artifact bridge to avoid PTY input limits.
  const buildScriptRef = '__fkn_runtime_build_script__'
  const buildScriptBytes = new TextEncoder().encode(script)
  imageCache.set(buildScriptRef, { promise: null, bytes: buildScriptBytes })
  const buildScriptURL = 'http://192.168.127.1:9090/img/' + encodeURIComponent(buildScriptRef)
  const launcher = "if wget -q '" + buildScriptURL +
    "' -O /tmp/fkn-build.sh; then sh /tmp/fkn-build.sh; else echo __FKN_BUILD_\"FAILED\"__; fi\n"

  // Wait for the shell to print a "# " prompt before pasting; ghostty-web's
  // buffer matches xterm.js's (baseY + cursorY → row index; getLine().translateToString()).
  let sent = false
  const pasteScript = (): void => {
    xterm.paste(launcher)
    markRuntimeTiming('build-script-sent')
  }
  const tryFeed = () => {
    if (sent) return
    const last = terminalTail(2).trimEnd()
    if (!/# *$/.test(last)) return
    sent = true
    markRuntimeTiming('guest-shell-ready')
    setRuntimeStage(2, 'Building Dockerfile in Linux')
    pasteScript()
  }
  const iv = setInterval(() => { tryFeed(); if (sent) clearInterval(iv) }, 1000)
  let serviceProbeStarted = false
  const buildTimer = setInterval(() => {
    const output = terminalTail(80).trimEnd()
    if (runtimeMarkers.buildFailed || runtimeMarkers.serviceFailed) {
      clearInterval(buildTimer)
      closeVirtualPort()
      if (serviceProbe) serviceProbe.disabled = true
      if (runtimeMarkers.serviceFailed && serviceResult) {
        serviceResult.textContent = serviceProbeStarted
          ? 'The image service exited'
          : 'The image command did not open guest port ' + publishSpec?.guestPort
      }
      if (serviceMode) {
        const message = runtimeMarkers.buildFailed
          ? 'Dockerfile build failed before the HTTP request.'
          : serviceProbeStarted
            ? 'The Docker HTTP service stopped and its virtual route closed.'
            : 'The Docker HTTP service did not open guest port ' + publishSpec?.guestPort + '.'
        setBrowserConsoleState(runtimeMarkers.buildFailed ? 'Build failed' : 'Service stopped', 'error')
        writeBrowserConsole('!', message, 'error')
      }
      setRuntimeStage(runtimeMarkers.buildFailed ? 2 : 3,
        runtimeMarkers.buildFailed
          ? 'Dockerfile build failed'
          : serviceProbeStarted ? 'Image service stopped' : 'Image service failed to start',
        'error')
      return
    }
    if (!runtimeMarkers.buildOk) return
    markRuntimeTiming('image-built')
    if (serviceMode) {
      if (serviceProbeStarted) return
      setRuntimeStage(3, 'Starting virtual HTTP service')
      if (serviceResult) serviceResult.textContent = 'Waiting for guest service on :' + publishSpec?.guestPort
      if (!runtimeMarkers.serviceReady) return
      markRuntimeTiming('guest-service-ready')
      if (serviceProbe) serviceProbe.disabled = false
      if (!serviceProbeStarted) {
        serviceProbeStarted = true
        void probeService(true)
      }
      return
    }
    setRuntimeStage(3, /\/ #\s*$/.test(output) ? 'Container shell ready' : 'Starting container shell')
    if (/\/ #\s*$/.test(output)) {
      clearInterval(buildTimer)
      if (serviceProbe) serviceProbe.disabled = false
    }
  }, 1000)
}

main().catch((e) => {
  closeRuntimeResources?.()
  setRuntimeStage(0, 'Runtime failed: ' + e, 'error')
  console.error('runtime bootstrap failed', e)
})
