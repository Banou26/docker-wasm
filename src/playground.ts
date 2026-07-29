import { withWasmAssetVersion } from './shared'
import {
  matchPreset,
  PRESET_DOCKERFILES,
  PRESET_RUNTIME_TIMEOUT_MS,
  PRESET_WASM_PATHS,
  type PresetName,
} from './presets'
import { planLaunch, type LaunchPlan } from './launch'
import type { Builder } from './builder'

const dropZone = document.getElementById('drop-zone')!
const pasteBox = document.getElementById('paste-box') as HTMLTextAreaElement
const runBtn = document.getElementById('run-btn') as HTMLButtonElement
const fileInput = document.getElementById('file-input') as HTMLInputElement
const editorMeta = document.getElementById('editor-meta')!
const buildOutlook = document.getElementById('build-outlook')
const status = document.getElementById('status')!
const runLabel = document.getElementById('run-label')!
const flightTitle = document.getElementById('flight-title')!
const finalStageTitle = document.getElementById('final-stage-title')!
const finalStageCopy = document.getElementById('final-stage-copy')!
const modeCopy = document.getElementById('mode-copy')!
const modeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-demo-mode]'))

type DemoMode = PresetName

let demoMode: DemoMode = 'shell'
const presetWarmups: Partial<Record<PresetName, Promise<void>>> = {}

const warmPresetRuntime = (mode: DemoMode = demoMode): void => {
  const source = mode === demoMode ? pasteBox.value : PRESET_DOCKERFILES[mode]
  const preset = matchPreset(source, mode === 'http' ? 8080 : null)
  if (!preset || presetWarmups[preset]) return

  presetWarmups[preset] = fetch(withWasmAssetVersion(PRESET_WASM_PATHS[preset]), {
    cache: 'force-cache',
    credentials: 'same-origin',
    signal: AbortSignal.timeout(PRESET_RUNTIME_TIMEOUT_MS),
  }).then(async (response) => {
    if (!response.ok) throw new Error('HTTP ' + response.status)
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.toLowerCase().includes('application/wasm')) {
      throw new Error('expected application/wasm, received ' + (contentType || 'no content type'))
    }
    await response.arrayBuffer()
  }).catch((error) => {
    delete presetWarmups[preset]
    console.info('[presets] ' + preset + ' runtime warmup did not complete: ' + error)
  })
}

// Start the guest download while the reader is still typing.
//
// It is between 15 and 49 MB depending on which guest the plan needs, and
// nothing about it depends on the Dockerfile being finished, so waiting for the
// button costs the whole download. Repeated calls for the same artifact are one
// request: the URL is versioned and the response is cached.
const warmed = new Set<string>()
const warmGuest = (guest: Builder): void => {
  const url = withWasmAssetVersion(guest.wasmPath)
  if (warmed.has(url)) return
  warmed.add(url)
  fetch(url, { cache: 'force-cache', credentials: 'same-origin' })
    .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error('HTTP ' + response.status))))
    .then(() => console.info('[warm] ' + guest.kind + ' ' + guest.arch + ' guest is cached'))
    .catch((error: unknown) => {
      warmed.delete(url)
      console.info('[warm] ' + guest.kind + ' guest did not prefetch: ' + String(error))
    })
}

const countBaseImages = (source: string): number => {
  const refs = new Set<string>()
  for (const line of source.split('\n')) {
    const match = line.trim().match(/^FROM\s+(?:--\S+\s+)*(\S+)/i)
    const ref = match?.[1]
    if (ref && ref.toLowerCase() !== 'scratch') refs.add(ref)
  }
  return refs.size
}

let warmTimer: ReturnType<typeof setTimeout> | undefined

const updateEditor = (): void => {
  const source = pasteBox.value.trim()
  const lines = source ? source.split('\n').length : 0
  const refs = source ? countBaseImages(source) : 0
  runBtn.disabled = !source
  editorMeta.textContent = lines + ' line' + (lines === 1 ? '' : 's') + ' / ' +
    refs + ' base image' + (refs === 1 ? '' : 's')

  let launch: LaunchPlan | null = null
  try {
    launch = source ? planLaunch({ dockerfile: pasteBox.value, mode: demoMode }) : null
  } catch {
    // A half-typed Dockerfile is the normal state of this box, not an error to
    // report. The outlook simply has nothing to say until it parses.
  }
  if (buildOutlook) {
    buildOutlook.textContent = launch
      ? launch.summary + (launch.preset
        ? ''
        : ' / ' + Math.round(launch.guest.approximateDownloadBytes / 1e6) + ' MB guest')
      : ''
    buildOutlook.hidden = !launch
  }

  // Settled, not per keystroke: the plan can flip between guests mid-edit, and
  // each guest is tens of megabytes.
  clearTimeout(warmTimer)
  if (launch && !launch.preset) {
    const { guest } = launch
    warmTimer = setTimeout(() => warmGuest(guest), 600)
  }
}

const selectDemoMode = (mode: DemoMode): void => {
  demoMode = mode
  const service = mode === 'http'
  pasteBox.value = PRESET_DOCKERFILES[mode]
  flightTitle.textContent = service ? 'From source to service.' : 'From source to shell.'
  finalStageTitle.textContent = service ? 'Connect' : 'Open'
  finalStageCopy.textContent = service ? 'In-process request into guest :8080' : 'Your container shell'
  modeCopy.textContent = service
    ? 'Launch the image command behind an in-process FKN virtual port.'
    : 'Open the image as an interactive shell.'
  runLabel.textContent = service ? 'Launch HTTP service' : 'Launch container shell'
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
  const mode = button.dataset.demoMode as DemoMode
  button.addEventListener('pointerenter', () => warmPresetRuntime(mode))
  button.addEventListener('focus', () => warmPresetRuntime(mode))
  button.addEventListener('click', () => selectDemoMode(mode))
}

const run = (): void => {
  const dockerfile = pasteBox.value
  if (!dockerfile.trim()) return
  const launch = planLaunch({ dockerfile, mode: demoMode })
  if (launch.preset) warmPresetRuntime()
  else warmGuest(launch.guest)
  runBtn.disabled = true
  runBtn.setAttribute('aria-busy', 'true')
  status.textContent = 'Opening runtime'
  status.className = 'status ok'
  location.assign(launch.url)
}

runBtn.addEventListener('click', run)
runBtn.addEventListener('pointerenter', () => warmPresetRuntime())
runBtn.addEventListener('focus', () => warmPresetRuntime())
runBtn.addEventListener('pointerdown', () => warmPresetRuntime())
pasteBox.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') run()
})

selectDemoMode('shell')
