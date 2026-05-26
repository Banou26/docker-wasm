// dockerfile-playground/backend.cjs
//
// Serves a drop-a-Dockerfile UI + the alpine-curl runtime frontend with COOP/COEP.
// POST a Dockerfile (text/plain) -> kicks off `docker build` + `c2w` -> streams
// the build log via SSE -> when ready, the browser navigates to /?net=webvpn&wasm=<id>
// which loads /wasm/<id>/out.wasm in the netstack-equipped runtime.

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')

const port = parseInt(process.env.PORT || '8080', 10)
const here = __dirname
const htdocs = path.join(here, '..', 'alpine-curl', 'htdocs')  // runtime assets
const playgroundWeb = path.join(here, 'web')                   // landing/drop UI
const jobsRoot = process.env.JOBS_DIR || '/tmp/c2w-playground'
fs.mkdirSync(jobsRoot, { recursive: true })

// ---- job management ------------------------------------------------------
// jobId -> {
//   id, dir, dockerfile, status: 'queued'|'building'|'done'|'failed',
//   logs: string[],                                            // append-only
//   listeners: Set<res>,                                       // SSE clients
//   startedAt, finishedAt, wasmSize, error?
// }
const jobs = new Map()
let buildQueue = Promise.resolve()  // serialize builds (one heavy job at a time)

function newJobId() { return crypto.randomBytes(8).toString('hex') }

function jobAppend(job, line) {
    job.logs.push(line)
    if (job.logs.length > 5000) job.logs.shift()
    for (const res of job.listeners) {
        try { res.write('data: ' + line.replace(/\n/g, '\\n') + '\n\n') } catch (_) {}
    }
}

function jobFinalEvent(job) {
    const payload = JSON.stringify({
        status: job.status,
        wasmSize: job.wasmSize,
        error: job.error,
        durationMs: job.finishedAt - job.startedAt,
    })
    for (const res of job.listeners) {
        try { res.write('event: done\ndata: ' + payload + '\n\n'); res.end() } catch (_) {}
    }
    job.listeners.clear()
}

function spawnLogged(job, cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        jobAppend(job, '$ ' + cmd + ' ' + args.join(' '))
        const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
        const onData = (b) => {
            const s = b.toString('utf8')
            for (const line of s.split(/\r?\n/)) {
                if (line) jobAppend(job, line)
            }
        }
        child.stdout.on('data', onData)
        child.stderr.on('data', onData)
        child.on('error', reject)
        child.on('exit', (code) => {
            if (code === 0) resolve()
            else reject(new Error(cmd + ' exited with code ' + code))
        })
    })
}

async function runBuild(job) {
    job.status = 'building'
    job.startedAt = Date.now()
    try {
        const dockerfilePath = path.join(job.dir, 'Dockerfile')
        fs.writeFileSync(dockerfilePath, job.dockerfile)
        const tag = 'c2w-playground-' + job.id
        await spawnLogged(job, 'docker', ['build', '-t', tag, job.dir])
        const wasmOut = path.join(job.dir, 'out.wasm')
        await spawnLogged(job, 'c2w', [tag, wasmOut])
        try { await spawnLogged(job, 'docker', ['image', 'rm', tag]) } catch (_) {}
        const st = fs.statSync(wasmOut)
        job.wasmSize = st.size
        job.wasmPath = wasmOut
        job.status = 'done'
        jobAppend(job, '✓ build done. ' + (st.size / 1024 / 1024).toFixed(1) + ' MiB')
    } catch (e) {
        job.status = 'failed'
        job.error = String(e && e.message || e)
        jobAppend(job, '✗ build failed: ' + job.error)
    } finally {
        job.finishedAt = Date.now()
        jobFinalEvent(job)
    }
}

function enqueueBuild(dockerfile) {
    const id = newJobId()
    const dir = path.join(jobsRoot, id)
    fs.mkdirSync(dir, { recursive: true })
    const job = {
        id, dir, dockerfile,
        status: 'queued',
        logs: ['queued; waiting for build slot...'],
        listeners: new Set(),
    }
    jobs.set(id, job)
    buildQueue = buildQueue.then(() => runBuild(job))
    return job
}

// ---- http ----------------------------------------------------------------
const types = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.cjs':  'application/javascript; charset=utf-8',
    '.mjs':  'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.css':  'text/css; charset=utf-8',
    '.conf': 'text/plain; charset=utf-8',
    '.svg':  'image/svg+xml',
}
const coiHeaders = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'credentialless',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': 'no-store',
}

function serveFile(res, full, extraHeaders = {}) {
    fs.stat(full, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); return res.end('not found') }
        res.writeHead(200, {
            'Content-Type': types[path.extname(full)] || 'application/octet-stream',
            'Content-Length': st.size,
            ...coiHeaders,
            ...extraHeaders,
        })
        fs.createReadStream(full).pipe(res)
    })
}

const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const p = u.pathname

    // POST /api/build  (body = Dockerfile text)
    if (req.method === 'POST' && p === '/api/build') {
        const chunks = []; let total = 0
        const cap = 256 * 1024
        req.on('data', (c) => { total += c.length; if (total > cap) { req.destroy(); return } chunks.push(c) })
        req.on('end', () => {
            if (total > cap) { res.writeHead(413); return res.end('Dockerfile too large') }
            const body = Buffer.concat(chunks).toString('utf8').trim()
            if (!body) { res.writeHead(400); return res.end('empty Dockerfile') }
            const job = enqueueBuild(body)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ jobId: job.id }))
        })
        return
    }

    // SSE: GET /api/build/:jobId/logs
    let m = p.match(/^\/api\/build\/([0-9a-f]+)\/logs$/)
    if (m) {
        const job = jobs.get(m[1])
        if (!job) { res.writeHead(404); return res.end('unknown job') }
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            'Connection': 'keep-alive',
        })
        // replay buffered logs, then stream
        for (const line of job.logs) res.write('data: ' + line.replace(/\n/g, '\\n') + '\n\n')
        if (job.status === 'done' || job.status === 'failed') {
            jobFinalEvent({ ...job, listeners: new Set([res]) })
            return
        }
        job.listeners.add(res)
        req.on('close', () => job.listeners.delete(res))
        return
    }

    // GET /wasm/:jobId/out.wasm
    m = p.match(/^\/wasm\/([0-9a-f]+)\/out\.wasm$/)
    if (m) {
        const job = jobs.get(m[1])
        if (!job || !job.wasmPath) { res.writeHead(404); return res.end('not built') }
        return serveFile(res, job.wasmPath)
    }

    // GET /playground/ -> the drop UI
    if (p === '/playground' || p === '/playground/' || p.startsWith('/playground/')) {
        let rel = p.replace(/^\/playground\/?/, '') || 'index.html'
        const full = path.normalize(path.join(playgroundWeb, rel))
        if (!full.startsWith(playgroundWeb)) { res.writeHead(403); return res.end() }
        return serveFile(res, full)
    }

    // Everything else: serve from the alpine-curl runtime htdocs (root).
    let rel = p.replace(/^\//, '') || 'index.html'
    const full = path.normalize(path.join(htdocs, rel))
    if (!full.startsWith(htdocs)) { res.writeHead(403); return res.end() }
    return serveFile(res, full)
})

server.listen(port, '127.0.0.1', () => {
    console.log('dockerfile-playground:')
    console.log('  drop UI    : http://127.0.0.1:' + port + '/playground/')
    console.log('  runtime    : http://127.0.0.1:' + port + '/?net=webvpn&wasm=<jobId>')
    console.log('  jobs dir   : ' + jobsRoot)
    console.log('  htdocs     : ' + htdocs)
})
