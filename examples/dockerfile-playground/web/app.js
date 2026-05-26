// Drop a Dockerfile. Encode into URL hash. Navigate to the c2w-webvpn runtime
// pointed at the prebuilt playground.wasm. That wasm runs `buildah` against
// the user's Dockerfile, then drops them into the built container.
//
// No server-side build. No SSE. No job ids. The "playground" is one static wasm.

const dropZone = document.getElementById('drop-zone')
const pasteBox = document.getElementById('paste-box')
const runBtn   = document.getElementById('run-btn')
const status   = document.getElementById('status')

const setEnabled = () => runBtn.disabled = !pasteBox.value.trim()
pasteBox.addEventListener('input', setEnabled)

;['dragenter', 'dragover'].forEach(ev =>
    dropZone.addEventListener(ev, e => {
        e.preventDefault(); e.stopPropagation()
        dropZone.classList.add('dragover')
    }))
;['dragleave', 'drop'].forEach(ev =>
    dropZone.addEventListener(ev, e => {
        e.preventDefault(); e.stopPropagation()
        dropZone.classList.remove('dragover')
    }))
dropZone.addEventListener('drop', async e => {
    const file = e.dataTransfer?.files?.[0]
    if (!file) return
    try {
        pasteBox.value = await file.text()
        setEnabled()
        status.textContent = 'loaded ' + file.name + ' (' + file.size + ' B)'
        status.className = 'status'
    } catch (err) {
        status.textContent = 'failed to read file: ' + err.message
        status.className = 'status err'
    }
})

// btoa with UTF-8 safety, then make URL-hash-safe.
function b64encodeUtf8(s) {
    const bytes = new TextEncoder().encode(s)
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    return btoa(bin).replace(/=+$/, '')
}

runBtn.addEventListener('click', () => {
    const dockerfile = pasteBox.value.trim()
    if (!dockerfile) return
    const b64 = b64encodeUtf8(dockerfile)
    const url = '/?net=webvpn&wasm-url=/playground/playground.wasm#dockerfile=' + b64
    location.assign(url)
})

setEnabled()
