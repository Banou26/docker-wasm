// Drop a Dockerfile, encode into URL hash, navigate to the c2w-webvpn runtime
// pointed at the prebuilt playground.wasm. No server-side build, no job ids —
// "playground" is one static wasm.

import { b64encodeUtf8, HASH_KEY_DOCKERFILE, QUERY_PARAMS } from '@c2w-webvpn/shared'

const dropZone = document.getElementById('drop-zone')!
const pasteBox = document.getElementById('paste-box') as HTMLTextAreaElement
const runBtn = document.getElementById('run-btn') as HTMLButtonElement
const status = document.getElementById('status')!

const setEnabled = (): void => { runBtn.disabled = !pasteBox.value.trim() }
pasteBox.addEventListener('input', setEnabled)

;(['dragenter', 'dragover'] as const).forEach((ev) =>
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation()
    dropZone.classList.add('dragover')
  }))
;(['dragleave', 'drop'] as const).forEach((ev) =>
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation()
    dropZone.classList.remove('dragover')
  }))

dropZone.addEventListener('drop', async (e: DragEvent) => {
  const file = e.dataTransfer?.files?.[0]
  if (!file) return
  try {
    pasteBox.value = await file.text()
    setEnabled()
    status.textContent = 'loaded ' + file.name + ' (' + file.size + ' B)'
    status.className = 'status'
  } catch (err) {
    status.textContent = 'failed to read file: ' + (err as Error).message
    status.className = 'status err'
  }
})

runBtn.addEventListener('click', () => {
  const dockerfile = pasteBox.value.trim()
  if (!dockerfile) return
  const b64 = b64encodeUtf8(dockerfile)
  const url =
    '/?' + QUERY_PARAMS.net + '=webvpn' +
    '&' + QUERY_PARAMS.wasmUrl + '=/playground/playground.wasm' +
    '#' + HASH_KEY_DOCKERFILE + '=' + b64
  location.assign(url)
})

setEnabled()
