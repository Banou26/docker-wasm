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
import { b64decodeUtf8, HASH_KEY_DOCKERFILE, QUERY_PARAMS } from './shared'

// Loaded into globals by /ws-delegate.js (kept as a static asset under public/).
declare const delegate: (worker: Worker, image: string, address: string) => (msg: MessageEvent) => void

let currentRuntimeStage = 0
let runtimeFailed = false
let closeRuntimeResources: (() => void) | null = null

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

const requestVirtualHTTP = async (
  virtualHost: string,
  virtualPort: number,
): Promise<{ status: number; body: string }> => {
  const { request } = await import('@fkn/lib/http')
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
      protocol: 'http:',
      hostname: virtualHost,
      port: virtualPort,
      path: '/',
      method: 'GET',
      headers: { Connection: 'close' },
    }, (response) => {
      const decoder = new TextDecoder()
      let body = ''
      response.on('data', (chunk: Uint8Array | string) => {
        if (body.length >= 2_000) return
        body += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      })
      response.on('end', () => finish(() => resolve({
        status: response.statusCode || 0,
        body: (body + decoder.decode()).slice(0, 2_000),
      })))
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
  const workerImage = wasmUrl
    ? new URL(wasmUrl, location.href).toString()
    : location.origin + (wasmId ? '/wasm/' + wasmId + '/out.wasm' : '/out.wasm')

  if (serviceMode) {
    document.getElementById('runtime-trace-target')!.textContent = 'to service'
    document.getElementById('runtime-final-title')!.textContent = 'Run service'
    document.getElementById('runtime-final-copy')!.textContent = 'HTTP through virtual TCP'
    const servicePanel = document.getElementById('service-panel')!
    servicePanel.hidden = false
    servicePanel.closest('.terminal-frame')?.classList.add('has-service')
  }
  const stackImage = netParam?.mode === 'browser'
    ? location.origin + '/c2w-net-proxy.wasm'
    : netParam?.mode === 'webvpn'
      ? location.origin + '/c2w-webvpn-proxy.wasm'
      : null
  await Promise.all([
    assertWasmAsset(workerImage, 'Guest image'),
    ...(stackImage ? [assertWasmAsset(stackImage, 'Network stack')] : []),
  ])
  setRuntimeStage(0, 'Booting Linux guest')

  // Image cache populated below from #dockerfile=<b64> in the URL hash.
  // createWebvpnNetstack reads from it when the proxy worker requests an
  // image_size or image_chunk for a FROM ref.
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
  const serviceEndpoint = document.getElementById('service-endpoint')
  const serviceResult = document.getElementById('service-result') as HTMLOutputElement | null
  const serviceProbe = document.getElementById('service-probe') as HTMLButtonElement | null
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
      return virtualPort
    }).catch((error) => {
      if (serviceResult) serviceResult.textContent = 'Virtual listener failed: ' + error
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
      const attempts = retry ? 8 : 1
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          serviceResult.textContent = attempt === 0 ? 'Sending GET /' : 'Waiting for guest service, retry ' + attempt
          const response = await requestVirtualHTTP(virtualPort.virtualHost, virtualPort.virtualPort)
          const preview = response.body.replace(/\s+/g, ' ').trim().slice(0, 120)
          serviceResult.textContent = response.status + ' / ' + (preview || 'empty response body')
          setRuntimeStage(3, 'HTTP service reachable through FKN in-process')
          return
        } catch (error) {
          lastError = error
          if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 2_000))
        }
      }
      throw lastError
    } catch (error) {
      serviceResult.textContent = 'Request failed: ' + error
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
        location.origin + '/c2w-net-proxy.wasm',
        ensureWebvpn,
      )
    } else if (netParam.mode === 'webvpn') {
      nwStack = newStack(
        worker, workerImage,
        new Worker('/webvpn-stack-worker.js' + location.search),
        location.origin + '/c2w-webvpn-proxy.wasm',
        ensureWebvpn,
      )
    }
  }
  if (!nwStack) {
    worker.postMessage({ type: 'init', imagename: workerImage })
  }
  new TtyServer(slave).start(worker as unknown as Parameters<TtyServer['start']>[0], nwStack)

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
  // them), then when the shell prompt appears, type a build script.
  if (dockerfileText === null || dockerfileB64 === null) {
    const promptTimer = setInterval(() => {
      if (!/# *$/.test(terminalTail(2).trimEnd())) return
      clearInterval(promptTimer)
      setRuntimeStage(3, 'Linux shell ready')
    }, 500)
    return
  }

  // Re-pad for the in-guest busybox base64 -d which is strict about padding.
  let dockerfileB64Padded = dockerfileB64
  while (dockerfileB64Padded.length % 4) dockerfileB64Padded += '='

  const refs = dockerfileFromRefs(dockerfileText)
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
      if (readyRefs === refs.length) setRuntimeStage(1, 'Base image ready, Linux booting')
    }, (error) => {
      closeVirtualPort()
      setRuntimeStage(1, 'Image pull failed: ' + error, 'error')
    })
  }

  const storageConf =
    '[storage]\\n' +
    'driver = "vfs"\\n' +
    'graphroot = "/var/lib/containers/storage"\\n' +
    'runroot = "/run/containers/storage"\\n' +
    '[storage.options]\\n'

  let pullBlock = ''
  for (const ref of refs) {
    const enc = encodeURIComponent(ref)
    const safe = ref.replace(/[^A-Za-z0-9._-]/g, '_')
    pullBlock +=
      'echo "== pull ' + ref + ' =="\n' +
      "wget -q 'http://192.168.127.1:9090/img/" + enc + "' -O /tmp/" + safe + ".tar || { echo wget-failed; exit 1; }\n" +
      'buildah pull docker-archive:/tmp/' + safe + '.tar\n'
  }
  const buildCommands =
    'mkdir -p /work /var/lib/containers/storage /run/containers/storage /etc/containers && cd /work\n' +
    "printf 'nameserver 192.168.127.1\\n' > /etc/resolv.conf\n" +
    "printf '" + storageConf + "' > /etc/containers/storage.conf\n" +
    pullBlock +
    "echo '" + dockerfileB64Padded + "' | base64 -d > Dockerfile\n" +
    'echo == buildah build ==\n' +
    'buildah bud --isolation chroot --network host --pull=never -t userimg .\n' +
    'echo == build complete ==\n'
  const defaultCommandSetup = runImageDefault
    ? 'cmdfile=/tmp/fkn-image-command\n' +
      'buildah inspect --type image --format \'{{range .Docker.Config.Entrypoint}}{{printf "%s%c" . 0}}{{end}}{{range .Docker.Config.Cmd}}{{printf "%s%c" . 0}}{{end}}\' userimg > "$cmdfile"\n' +
      'set --\n' +
      'while IFS= read -r -d \'\' arg; do set -- "$@" "$arg"; done < "$cmdfile"\n' +
      '[ "$#" -gt 0 ] || { echo "image has no default command" >&2; echo __FKN_SERVICE_"FAILED"__; exit 1; }\n'
    : ''
  const containerCommand = runImageDefault ? ' "$@"' : ' /bin/sh'
  const containerLaunch = serviceMode && publishSpec
    ? '  ctr=$(buildah from userimg) || { echo __FKN_SERVICE_"FAILED"__; exit 1; }\n' +
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
    : '  ctr=$(buildah from userimg) && exec buildah run --network host --terminal --env TERM=dumb "$ctr"' + containerCommand + '\n'
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

  // Wait for the shell to print a "# " prompt before pasting; ghostty-web's
  // buffer matches xterm.js's (baseY + cursorY → row index; getLine().translateToString()).
  let sent = false
  const pasteScript = async (): Promise<void> => {
    for (let offset = 0; offset < script.length; offset += 512) {
      xterm.paste(script.slice(offset, offset + 512))
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  const tryFeed = () => {
    if (sent) return
    const last = terminalTail(2).trimEnd()
    if (!/# *$/.test(last)) return
    sent = true
    setRuntimeStage(2, 'Building Dockerfile in Linux')
    void pasteScript()
  }
  const iv = setInterval(() => { tryFeed(); if (sent) clearInterval(iv) }, 1000)
  let serviceProbeStarted = false
  const buildTimer = setInterval(() => {
    const output = terminalTail(80).trimEnd()
    if (runtimeMarkers.buildFailed || runtimeMarkers.serviceFailed) {
      clearInterval(buildTimer)
      closeVirtualPort()
      if (runtimeMarkers.serviceFailed && serviceResult) {
        serviceResult.textContent = serviceProbeStarted
          ? 'The image service exited'
          : 'The image command did not open guest port ' + publishSpec?.guestPort
      }
      setRuntimeStage(runtimeMarkers.buildFailed ? 2 : 3,
        runtimeMarkers.buildFailed
          ? 'Dockerfile build failed'
          : serviceProbeStarted ? 'Image service stopped' : 'Image service failed to start',
        'error')
      return
    }
    if (!runtimeMarkers.buildOk) return
    if (serviceMode) {
      if (serviceProbeStarted) return
      setRuntimeStage(3, 'Starting virtual HTTP service')
      if (serviceResult) serviceResult.textContent = 'Waiting for guest service on :' + publishSpec?.guestPort
      if (!runtimeMarkers.serviceReady) return
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
