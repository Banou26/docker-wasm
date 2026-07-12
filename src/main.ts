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
import { newStack, type Netstack } from './stack'
import { createWebvpnNetstack, type ImageCache } from './webvpn-netstack'
import { pullImage, dockerfileFromRefs } from './registry'
import { b64decodeUtf8, HASH_KEY_DOCKERFILE, QUERY_PARAMS, type NetMode } from './shared'

// Loaded into globals by /ws-delegate.js (kept as a static asset under public/).
declare const delegate: (worker: Worker, image: string, address: string) => (msg: MessageEvent) => void

const setRuntimeStage = (stage: number, message: string, tone: 'normal' | 'error' = 'normal'): void => {
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

  // Resize the terminal to fill its container. FitAddon installs its own
  // ResizeObserver on the parent so the canvas tracks viewport changes; each
  // xterm.resize(cols, rows) fires master.onResize -> slave.notifyResize, which
  // pushes SIGWINCH (with the new winsize) up to the c2w guest.
  const fitAddon = new FitAddon()
  xterm.loadAddon(fitAddon)
  fitAddon.fit()

  const { master, slave } = openpty()
  const termios = slave.ioctl('TCGETS')
  // Pass through bytes verbatim - the c2w guest does its own line discipline.
  const iflag = termios.iflag & ~(ISTRIP | INLCR | IGNCR | ICRNL | IXON)
  const oflag = termios.oflag & ~OPOST
  const lflag = termios.lflag & ~(ECHO | ECHONL | ICANON | ISIG | IEXTEN)
  slave.ioctl('TCSETS', new Termios(iflag, oflag, termios.cflag, lflag, termios.cc))
  xterm.loadAddon(master as Parameters<typeof xterm.loadAddon>[0])

  const queryParams = new URLSearchParams(location.search)
  const wasmUrl = queryParams.get(QUERY_PARAMS.wasmUrl)
  const wasmId = queryParams.get(QUERY_PARAMS.wasm)
  const workerImage = wasmUrl
    ? new URL(wasmUrl, location.href).toString()
    : location.origin + (wasmId ? '/wasm/' + wasmId + '/out.wasm' : '/out.wasm')

  const netParam = getNetParam()
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

  const worker = new Worker('/worker.js' + location.search)

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
    const buf = xterm.buffer.active
    const cursorRow = buf.baseY + buf.cursorY
    let text = ''
    for (let y = Math.max(0, cursorRow - count); y <= cursorRow; y++) {
      const line = buf.getLine(y)
      if (line) text += line.translateToString(true) + '\n'
    }
    return text
  }

  // In-browser dockerfile playground: if location.hash carries a base64
  // Dockerfile, kick off the FROM-image pulls in JS right now (so the netstack
  // proxy's gateway HTTP server has bytes ready by the time the guest wget's
  // them), then when the shell prompt appears, type a build script.
  const m = location.hash.match(new RegExp('(?:^#|&)' + HASH_KEY_DOCKERFILE + '=([^&]+)'))
  if (!m || !m[1]) {
    const promptTimer = setInterval(() => {
      if (!/# *$/.test(terminalTail(2).trimEnd())) return
      clearInterval(promptTimer)
      setRuntimeStage(3, 'Linux shell ready')
    }, 500)
    return
  }

  const dockerfileB64 = decodeURIComponent(m[1])
  const dockerfileText = b64decodeUtf8(dockerfileB64)
  // Re-pad for the in-guest busybox base64 -d which is strict about padding.
  let dockerfileB64Padded = dockerfileB64
  while (dockerfileB64Padded.length % 4) dockerfileB64Padded += '='

  const refs = dockerfileFromRefs(dockerfileText)
  setRuntimeStage(1, 'Pulling ' + refs.length + ' base image' + (refs.length === 1 ? '' : 's'))
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
    'echo == running container ==\n' +
    'ctr=$(buildah from userimg) && buildah run --network host --terminal --env TERM=dumb "$ctr" /bin/sh\n'
  const script = "sh -eu <<'FKN_BUILD'\n" + buildCommands + 'FKN_BUILD\n'

  // Wait for the shell to print a "# " prompt before pasting; ghostty-web's
  // buffer matches xterm.js's (baseY + cursorY → row index; getLine().translateToString()).
  let sent = false
  const tryFeed = () => {
    if (sent) return
    const last = terminalTail(2)
    if (!/# *$/.test(last)) return
    sent = true
    setRuntimeStage(2, 'Building Dockerfile in Linux')
    xterm.paste(script)
  }
  const iv = setInterval(() => { tryFeed(); if (sent) clearInterval(iv) }, 1000)
  const buildTimer = setInterval(() => {
    const output = terminalTail(80)
    if (output.includes('Error: building at STEP')) {
      clearInterval(buildTimer)
      setRuntimeStage(2, 'Dockerfile build failed', 'error')
      return
    }
    if (!output.includes('Successfully tagged')) return
    setRuntimeStage(3, /\/ #\s*$/.test(output) ? 'Container shell ready' : 'Starting container shell')
    if (/\/ #\s*$/.test(output)) clearInterval(buildTimer)
  }, 1000)
}

main().catch((e) => {
  setRuntimeStage(0, 'Runtime failed: ' + e, 'error')
  console.error('runtime bootstrap failed', e)
})
