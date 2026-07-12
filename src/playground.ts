import { b64encodeUtf8, HASH_KEY_DOCKERFILE, QUERY_PARAMS } from './shared'

const dropZone = document.getElementById('drop-zone')!
const pasteBox = document.getElementById('paste-box') as HTMLTextAreaElement
const runBtn = document.getElementById('run-btn') as HTMLButtonElement
const fileInput = document.getElementById('file-input') as HTMLInputElement
const editorMeta = document.getElementById('editor-meta')!
const status = document.getElementById('status')!

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

const run = (): void => {
  const dockerfile = pasteBox.value.trim()
  if (!dockerfile) return
  runBtn.disabled = true
  runBtn.setAttribute('aria-busy', 'true')
  status.textContent = 'Opening runtime'
  status.className = 'status ok'
  const url =
    '/?' + QUERY_PARAMS.net + '=webvpn' +
    '&' + QUERY_PARAMS.wasmUrl + '=/playground/playground.wasm' +
    '#' + HASH_KEY_DOCKERFILE + '=' + b64encodeUtf8(dockerfile)
  location.assign(url)
}

runBtn.addEventListener('click', run)
pasteBox.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') run()
})

updateEditor()
