import { assertCrossOriginIsolated, createContainer, preloadContainer, type Container } from './lib'
import { PRESET_WASM_PATHS } from './presets'
import { withWasmAssetVersion } from './shared'

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id)
  if (!found) throw new Error('#' + id + ' is missing')
  return found as T
}

const bootButton = element<HTMLButtonElement>('boot')
const bootLabel = element('boot-label')
const isolationState = element('isolation-state')
const timeline = element('timeline')
const requestForm = element<HTMLFormElement>('request-form')
const requestMethod = element<HTMLSelectElement>('request-method')
const requestPath = element<HTMLInputElement>('request-path')
const sendButton = element<HTMLButtonElement>('send')
const requestNote = element('request-note')
const callTrace = element('call-trace')
const responseStatus = element('response-status')
const responseBody = element('response-body')
const logs = element<HTMLPreElement>('logs')

const imageURL = withWasmAssetVersion(PRESET_WASM_PATHS.http)
const netstackURL = withWasmAssetVersion('/c2w-webvpn-proxy.wasm')

let container: Container | null = null
let inFlight = false

const setStep = (
  step: 'download' | 'compile' | 'boot' | 'serve',
  state: 'idle' | 'active' | 'done' | 'failed',
  detail: string,
): void => {
  const node = timeline.querySelector<HTMLElement>('[data-step="' + step + '"]')
  if (!node) return
  node.dataset.state = state
  const small = node.querySelector('small')
  if (small) small.textContent = detail
}

const resetTimeline = (): void => {
  setStep('download', 'idle', 'idle')
  setStep('compile', 'idle', 'idle')
  setStep('boot', 'idle', 'idle')
  setStep('serve', 'idle', 'idle')
}

const seconds = (ms: number): string =>
  ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(ms < 10_000 ? 2 : 1) + ' s'

const megabytes = (bytes: number): string => (bytes / 1e6).toFixed(1) + ' MB'

const decoder = new TextDecoder()
const ANSI = /\u001B(?:\[[0-9;?]*[ -/]*[@-~]|[()][A-Za-z0-9]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|[=>NOM78])/g
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

const appendLog = (bytes: Uint8Array): void => {
  const text = decoder.decode(bytes, { stream: true })
    .replace(ANSI, '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
  if (!text) return
  logs.textContent = ((logs.textContent ?? '') + text).slice(-16_000)
  logs.scrollTop = logs.scrollHeight
}

const traceLine = (text: string, tone: 'call' | 'ok' | 'error' | 'note'): HTMLElement => {
  const line = document.createElement('div')
  line.className = 'trace-line is-' + tone
  line.textContent = text
  callTrace.append(line)
  callTrace.scrollTop = callTrace.scrollHeight
  return line
}

const renderResponse = async (response: Response, elapsedMs: number): Promise<void> => {
  const tone = response.ok ? 'ok' : 'error'
  responseStatus.dataset.tone = tone
  responseStatus.textContent = response.status + ' ' + (response.statusText || '') + ' / ' + seconds(elapsedMs)

  const headerRows = Array.from(response.headers.entries())
    .map(([name, value]) => '<div class="header-row"><span>' + escapeHtml(name) + '</span><code>' +
      escapeHtml(value) + '</code></div>')
    .join('')

  const raw = await response.text()
  let bodyMarkup = '<pre class="body-block">' + escapeHtml(raw) + '</pre>'
  const contentType = (response.headers.get('content-type') || '').toLowerCase()
  if (contentType.includes('application/json')) {
    try {
      bodyMarkup = '<pre class="body-block">' + highlightJson(JSON.parse(raw)) + '</pre>'
    } catch {}
  }

  responseBody.innerHTML =
    '<div class="header-block">' + headerRows + '</div>' + bodyMarkup
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"]/g, (char) =>
    char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : '&quot;')

const highlightJson = (value: unknown): string =>
  JSON.stringify(value, null, 2)
    .replace(/[&<>]/g, (char) => (char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;'))
    .replace(/"([^"]*)":/g, '<span class="tok-prop">"$1"</span>:')
    .replace(/: "([^"]*)"/g, ': <span class="tok-str">"$1"</span>')
    .replace(/: (-?\d+(?:\.\d+)?)/g, ': <span class="tok-num">$1</span>')
    .replace(/: (true|false|null)/g, ': <span class="tok-key">$1</span>')

const setRequestsEnabled = (enabled: boolean, note: string): void => {
  sendButton.disabled = !enabled
  requestPath.disabled = !enabled
  requestMethod.disabled = !enabled
  requestNote.textContent = note
  for (const button of requestForm.querySelectorAll<HTMLButtonElement>('.request-hints button')) {
    button.disabled = !enabled
  }
}

const boot = (): void => {
  if (container) return
  try {
    assertCrossOriginIsolated()
  } catch (error) {
    isolationState.textContent = 'Not cross-origin isolated'
    traceLine(String(error instanceof Error ? error.message : error), 'error')
    return
  }

  bootButton.disabled = true
  bootLabel.textContent = 'Starting'
  resetTimeline()
  setStep('download', 'active', 'requesting')
  logs.textContent = ''
  callTrace.replaceChildren()
  traceLine('createContainer({ image, ports: [8080] })', 'call')

  container = createContainer({
    image: imageURL,
    netstackImage: netstackURL,
    ports: [8080],
    onLog: appendLog,
    onStatus: (status) => {
      switch (status.phase) {
        case 'fetching':
          if (status.source !== 'guest') return
          setStep('download', 'active', status.bytes ? megabytes(status.bytes) + ' streaming' : 'streaming')
          setStep('compile', 'active', 'compiling while it downloads')
          break
        case 'compiled':
          if (status.source !== 'guest') return
          setStep('download', 'done', seconds(status.elapsedMs))
          setStep('compile', 'done', seconds(status.elapsedMs))
          setStep('boot', 'active', 'restoring the guest')
          break
        case 'running':
          if (status.source !== 'guest') return
          setStep('boot', 'active', 'kernel running')
          break
        case 'serving':
          setStep('boot', 'done', 'up')
          setStep('serve', 'done', seconds(status.elapsedMs))
          break
        case 'failed':
          setStep('serve', 'failed', 'failed')
          traceLine(status.error.message, 'error')
          bootButton.disabled = false
          bootLabel.textContent = 'Try again'
          break
      }
    },
  })

  container.ready.then(() => {
    bootLabel.textContent = 'Container running'
    const port = container?.ports[0]
    setRequestsEnabled(true, port
      ? 'Routed to guest :8080 through ' + port.host + ':' + port.port
      : 'Ready')
    traceLine('port 8080 published, sending the first request', 'note')
    void send('GET', requestPath.value || '/hello', { first: true })
  }, (error: unknown) => {
    traceLine(String(error instanceof Error ? error.message : error), 'error')
    bootButton.disabled = false
    bootLabel.textContent = 'Try again'
  })
}

const send = async (
  method: string,
  path: string,
  options: { first?: boolean; quiet?: boolean } = {},
): Promise<number | null> => {
  if (!container || inFlight) return null
  inFlight = true
  sendButton.disabled = true
  const startedAt = performance.now()
  if (!options.quiet) {
    traceLine('await api.fetch(' + JSON.stringify(path) + (method === 'GET' ? '' : ', { method: "' + method + '" }') + ')', 'call')
  }
  if (options.first) {
    responseStatus.dataset.tone = 'pending'
    responseStatus.textContent = 'waiting for the guest'
  }
  try {
    const response = await container.fetch(path, { method })
    const elapsedMs = Math.round(performance.now() - startedAt)
    await renderResponse(response, elapsedMs)
    if (!options.quiet) traceLine('-> ' + response.status + ' in ' + seconds(elapsedMs), 'ok')
    return elapsedMs
  } catch (error) {
    responseStatus.dataset.tone = 'error'
    responseStatus.textContent = 'failed'
    traceLine(String(error instanceof Error ? error.message : error), 'error')
    return null
  } finally {
    inFlight = false
    sendButton.disabled = !container
  }
}

const burst = async (count: number): Promise<void> => {
  if (!container) return
  const path = requestPath.value || '/hello'
  traceLine('sending ' + count + ' sequential requests to ' + path, 'note')
  const timings: number[] = []
  for (let index = 0; index < count; index++) {
    const elapsed = await send('GET', path, { quiet: true })
    if (elapsed === null) return
    timings.push(elapsed)
  }
  const sorted = timings.slice().sort((left, right) => left - right)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  traceLine(
    count + ' requests: min ' + sorted[0] + ' ms, median ' + median + ' ms, max ' +
    sorted[sorted.length - 1] + ' ms',
    'ok',
  )
}

requestForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void send(requestMethod.value, requestPath.value || '/')
})

for (const button of requestForm.querySelectorAll<HTMLButtonElement>('.request-hints button')) {
  button.addEventListener('click', () => {
    const repeat = button.dataset.repeat
    if (repeat) {
      void burst(Number(repeat))
      return
    }
    requestPath.value = button.dataset.path || '/'
    void send(requestMethod.value, requestPath.value)
  })
}

bootButton.addEventListener('click', boot)
for (const event of ['pointerenter', 'focus'] as const) {
  bootButton.addEventListener(event, () => {
    void preloadContainer(imageURL).catch(() => {})
    void preloadContainer(netstackURL).catch(() => {})
  }, { once: true })
}

addEventListener('pagehide', () => { void container?.stop() }, { once: true })

setRequestsEnabled(false, 'Start the container to enable requests.')
isolationState.textContent = globalThis.crossOriginIsolated ? 'Cross-origin isolated' : 'Isolation headers missing'
