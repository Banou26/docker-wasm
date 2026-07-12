import { b64encodeUtf8, HASH_KEY_DOCKERFILE, QUERY_PARAMS } from './shared'

const dropZone = document.getElementById('drop-zone')!
const pasteBox = document.getElementById('paste-box') as HTMLTextAreaElement
const runBtn = document.getElementById('run-btn') as HTMLButtonElement
const fileInput = document.getElementById('file-input') as HTMLInputElement
const editorMeta = document.getElementById('editor-meta')!
const status = document.getElementById('status')!
const runLabel = document.getElementById('run-label')!
const flightTitle = document.getElementById('flight-title')!
const finalStageTitle = document.getElementById('final-stage-title')!
const finalStageCopy = document.getElementById('final-stage-copy')!
const modeCopy = document.getElementById('mode-copy')!
const modeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-demo-mode]'))

type DemoMode = 'shell' | 'http'

const SHELL_DOCKERFILE = `FROM alpine:3.19

RUN apk add --no-cache curl

CMD ["/bin/sh"]`

const HTTP_BODY = JSON.stringify({
  ok: true,
  message: 'Hello from inside the Docker image.',
  service: 'guest:8080',
  transport: 'FKN virtual TCP',
})
const HTTP_RESPONSE_COMMAND = `printf 'HTTP/1.0 200 OK\\r\\nContent-Type: application/json; charset=utf-8\\r\\nContent-Length: ${new TextEncoder().encode(HTTP_BODY).byteLength}\\r\\nConnection: close\\r\\n\\r\\n${HTTP_BODY}'`
  .replace(/[\\"$`]/g, '\\$&')

const HTTP_DOCKERFILE = `FROM alpine:3.19

RUN mkdir -p /www && printf '%s\\n' '#!/bin/sh' "${HTTP_RESPONSE_COMMAND}" > /www/serve && chmod +x /www/serve

EXPOSE 8080
CMD ["/bin/busybox", "nc", "-lk", "-p", "8080", "-e", "/www/serve"]`

let demoMode: DemoMode = 'shell'

const countBaseImages = (source: string): number => {
  const refs = new Set<string>()
  for (const line of source.split('\n')) {
    const match = line.trim().match(/^FROM\s+(?:--\S+\s+)*(\S+)/i)
    const ref = match?.[1]
    if (ref && ref.toLowerCase() !== 'scratch') refs.add(ref)
  }
  return refs.size
}

const updateEditor = (): void => {
  const source = pasteBox.value.trim()
  const lines = source ? source.split('\n').length : 0
  const refs = source ? countBaseImages(source) : 0
  runBtn.disabled = !source
  editorMeta.textContent = lines + ' line' + (lines === 1 ? '' : 's') + ' / ' +
    refs + ' base image' + (refs === 1 ? '' : 's')
}

const selectDemoMode = (mode: DemoMode): void => {
  demoMode = mode
  const service = mode === 'http'
  pasteBox.value = service ? HTTP_DOCKERFILE : SHELL_DOCKERFILE
  flightTitle.textContent = service ? 'From source to service.' : 'From source to shell.'
  finalStageTitle.textContent = service ? 'Connect' : 'Open'
  finalStageCopy.textContent = service ? 'In-process request into guest :8080' : 'Your container shell'
  modeCopy.textContent = service
    ? 'Run the image command behind an in-process FKN virtual port.'
    : 'Build the image, then work inside its shell.'
  runLabel.textContent = service ? 'Build and connect service' : 'Boot this Dockerfile'
  for (const button of modeButtons) {
    const active = button.dataset.demoMode === mode
    button.classList.toggle('is-active', active)
    button.setAttribute('aria-pressed', String(active))
  }
  status.textContent = service ? 'HTTP service example loaded' : 'Shell example loaded'
  status.className = 'status ok'
  updateEditor()
}

const loadFile = async (file: File): Promise<void> => {
  try {
    pasteBox.value = await file.text()
    status.textContent = file.name + ' loaded'
    status.className = 'status ok'
    updateEditor()
  } catch (error) {
    status.textContent = 'Could not read file: ' + (error as Error).message
    status.className = 'status err'
  }
}

pasteBox.addEventListener('input', () => {
  status.textContent = 'Edited locally'
  status.className = 'status'
  updateEditor()
})

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0]
  if (file) void loadFile(file)
})

;(['dragenter', 'dragover'] as const).forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault()
    event.stopPropagation()
    dropZone.classList.add('dragover')
  })
})

;(['dragleave', 'drop'] as const).forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault()
    event.stopPropagation()
    dropZone.classList.remove('dragover')
  })
})

dropZone.addEventListener('drop', (event: DragEvent) => {
  const file = event.dataTransfer?.files?.[0]
  if (file) void loadFile(file)
})

for (const button of modeButtons) {
  button.addEventListener('click', () => selectDemoMode(button.dataset.demoMode as DemoMode))
}

const run = (): void => {
  const dockerfile = pasteBox.value.trim()
  if (!dockerfile) return
  runBtn.disabled = true
  runBtn.setAttribute('aria-busy', 'true')
  status.textContent = 'Opening runtime'
  status.className = 'status ok'
  const params = new URLSearchParams({
    [QUERY_PARAMS.net]: 'webvpn',
    [QUERY_PARAMS.wasmUrl]: '/playground/playground.wasm',
  })
  if (demoMode === 'http') {
    params.set(QUERY_PARAMS.publish, 'tcp:8080')
    params.set(QUERY_PARAMS.run, 'default')
  }
  const url = '/?' + params + '#' + HASH_KEY_DOCKERFILE + '=' + b64encodeUtf8(dockerfile)
  location.assign(url)
}

runBtn.addEventListener('click', run)
pasteBox.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') run()
})

updateEditor()
