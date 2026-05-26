// Drop-a-Dockerfile playground. Single file, plain JS.
const dropZone = document.getElementById('drop-zone')
const pasteBox = document.getElementById('paste-box')
const buildBtn = document.getElementById('build-btn')
const status   = document.getElementById('status')
const logSec   = document.getElementById('log-section')
const logEl    = document.getElementById('log')
const logMeta  = document.getElementById('log-meta')
const runSec   = document.getElementById('run-section')
const runLink  = document.getElementById('run-link')
const runSummary = document.getElementById('run-summary')

const setEnabled = () => buildBtn.disabled = !pasteBox.value.trim()
pasteBox.addEventListener('input', setEnabled)

// --- drag & drop --------------------------------------------------------
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
        const text = await file.text()
        pasteBox.value = text
        setEnabled()
        status.textContent = 'loaded ' + file.name + ' (' + file.size + ' B)'
        status.className = 'status'
    } catch (err) {
        status.textContent = 'failed to read file: ' + err.message
        status.className = 'status err'
    }
})

// --- build --------------------------------------------------------------
const t0Of = () => Date.now()
let startedAt = 0
let durationTimer = null

function appendLog(line) {
    const at = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 4
    logEl.textContent += line + '\n'
    if (at) logEl.scrollTop = logEl.scrollHeight
}

function tickDuration() {
    const s = ((Date.now() - startedAt) / 1000).toFixed(0)
    logMeta.textContent = s + 's'
}

buildBtn.addEventListener('click', async () => {
    const dockerfile = pasteBox.value.trim()
    if (!dockerfile) return

    buildBtn.disabled = true
    pasteBox.disabled = true
    status.textContent = 'queued…'
    status.className = 'status'
    logSec.classList.remove('hidden')
    runSec.classList.add('hidden')
    logEl.textContent = ''
    logMeta.textContent = ''
    startedAt = t0Of()
    durationTimer = setInterval(tickDuration, 1000)

    let jobId
    try {
        const r = await fetch('/api/build', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: dockerfile,
        })
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + await r.text())
        ;({ jobId } = await r.json())
    } catch (e) {
        status.textContent = 'failed to start build: ' + e.message
        status.className = 'status err'
        clearInterval(durationTimer)
        pasteBox.disabled = false
        buildBtn.disabled = false
        return
    }

    status.textContent = 'building (job ' + jobId + ')…'
    const es = new EventSource('/api/build/' + jobId + '/logs')
    es.onmessage = (m) => {
        const txt = m.data.replace(/\\n/g, '\n')
        appendLog(txt)
    }
    es.addEventListener('done', (m) => {
        const result = JSON.parse(m.data)
        es.close()
        clearInterval(durationTimer)
        const secs = (result.durationMs / 1000).toFixed(0)
        logMeta.textContent = secs + 's'
        if (result.status === 'done') {
            status.textContent = 'built in ' + secs + 's · ' + (result.wasmSize / 1024 / 1024).toFixed(1) + ' MiB'
            status.className = 'status ok'
            runSummary.textContent = 'Container wasm is ready. Opening it loads the netstack runtime ' +
                                     '(@webvpn egress). First boot of Bochs takes a few minutes.'
            runLink.href = '/?net=webvpn&wasm=' + jobId
            runSec.classList.remove('hidden')
        } else {
            status.textContent = 'build failed: ' + (result.error || 'unknown')
            status.className = 'status err'
        }
        pasteBox.disabled = false
        buildBtn.disabled = false
    })
    es.onerror = () => {
        // EventSource auto-reconnects; the server replays the buffer. Ignore.
    }
})

setEnabled()
