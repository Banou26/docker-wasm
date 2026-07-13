// Static server for the docker-wasm runtime + playground.
//
// Serves the Vite build output:
//   /                            runtime (build/index.html)
//   /playground/                 drop UI (build/playground/index.html)
//   /playground/playground.wasm  the c2w-built alpine+buildah image (one-time, ~150 MB)
//   /proxy                       fkn-proxy-compatible CORS shim for in-browser
//                                Docker Hub pulls
//
// COOP same-origin + COEP credentialless throughout, so SharedArrayBuffer works
// for the wasi-on-browser worker bridge and the @fkn/lib RPC iframe loads.
//
// NO docker, NO c2w, NO build queue. The "build" runs inside the wasm guest.
const http = require('http')
const fs = require('fs')
const path = require('path')

const port = parseInt(process.env.PORT || '8080', 10)
const here = __dirname
const root = path.join(here, '..', 'build')
let wasmVersions = {}
try {
    wasmVersions = JSON.parse(fs.readFileSync(path.join(root, 'wasm-versions.json'), 'utf8'))
} catch (_) {}

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
    // credentialless allows cross-origin iframes (e.g., @fkn/lib's
    // https://fkn.app/api bridge) while still giving SharedArrayBuffer.
    'Cross-Origin-Embedder-Policy': 'credentialless',
    'Cross-Origin-Resource-Policy': 'cross-origin',
}
const dynamicHeaders = {
    ...coiHeaders,
    'Cache-Control': 'no-store',
}

function serveFile(req, res, full, immutable) {
    fs.stat(full, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); return res.end('not found') }

        const finish = (servedFile, servedStat, encoding) => {
            const etag = '"' + servedStat.size.toString(16) + '-' + Math.floor(servedStat.mtimeMs).toString(16) + '"'
            const headers = {
                'Content-Type': types[path.extname(full)] || 'application/octet-stream',
                'Content-Length': servedStat.size,
                'Cache-Control': immutable
                    ? 'public, max-age=31536000, immutable'
                    : 'public, max-age=0, must-revalidate',
                'ETag': etag,
                ...coiHeaders,
            }
            if (path.extname(full) === '.wasm') headers.Vary = 'Accept-Encoding'
            if (encoding) headers['Content-Encoding'] = encoding
            const matches = (req.headers['if-none-match'] || '').split(',').map((value) => value.trim())
            if (matches.includes(etag)) {
                delete headers['Content-Length']
                res.writeHead(304, headers)
                return res.end()
            }
            res.writeHead(200, headers)
            if (req.method === 'HEAD') return res.end()
            fs.createReadStream(servedFile).pipe(res)
        }

        const acceptsGzip = acceptsEncoding(req.headers['accept-encoding'], 'gzip')
        if (path.extname(full) === '.wasm' && acceptsGzip) {
            const compressed = full + '.gz'
            fs.stat(compressed, (gzipErr, gzipStat) => {
                if (!gzipErr && gzipStat.isFile()) return finish(compressed, gzipStat, 'gzip')
                finish(full, st)
            })
            return
        }
        finish(full, st)
    })
}

function acceptsEncoding(header, wanted) {
    let wildcard = false
    for (const item of String(header || '').split(',')) {
        const [rawName, ...params] = item.split(';')
        const name = rawName.trim().toLowerCase()
        const qParam = params.map((part) => part.trim()).find((part) => /^q\s*=/i.test(part))
        const quality = qParam ? Number(qParam.slice(qParam.indexOf('=') + 1).trim()) : 1
        const accepted = Number.isFinite(quality) && quality > 0
        if (name === wanted) return accepted
        if (name === '*') wildcard = accepted
    }
    return wildcard
}

// fkn-proxy-compatible shim. @fkn/lib's serverProxyFetch (in fkn/web) sends
// fetches here with fkn-proxy-{protocol,hostname,pathname,search,headers}
// describing the *real* target. We reconstruct, fetch upstream, and return the
// upstream response with its headers re-packed under fkn-proxy-headers so the
// caller sees the real status/headers/body. CORS headers are set so the
// cross-origin fkn/web iframe (e.g. http://127.0.0.1:1234) can reach us.
//
// This is a drop-in for fkn/proxy when you don't need anti-bot / Postgres
// caching - for plain Docker Hub HTTPS it's all we need.
async function handleProxy(req, res) {
    try {
        const protocol = (req.headers['fkn-proxy-protocol'] || 'https').toString()
        const hostname = req.headers['fkn-proxy-hostname']
        const pathname = req.headers['fkn-proxy-pathname'] || '/'
        const search   = req.headers['fkn-proxy-search']   || ''
        if (!hostname) { res.writeHead(400); return res.end('missing fkn-proxy-hostname') }
        const target = protocol + '://' + hostname + pathname + search

        let upstreamHeaders = {}
        const hdrB64 = req.headers['fkn-proxy-headers']
        if (hdrB64) {
            try {
                const parsed = JSON.parse(Buffer.from(hdrB64.toString(), 'base64').toString('utf8'))
                if (Array.isArray(parsed)) {
                    for (const [k, v] of parsed) upstreamHeaders[k] = v
                } else if (parsed && typeof parsed === 'object') {
                    upstreamHeaders = parsed
                }
            } catch (_) {}
        }

        let body
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            const chunks = []
            for await (const c of req) chunks.push(c)
            if (chunks.length) body = Buffer.concat(chunks)
        }

        const up = await globalThis.fetch(target, {
            method: req.method,
            headers: upstreamHeaders,
            body,
            redirect: 'follow',
        })
        const respHeadersObj = {}
        up.headers.forEach((v, k) => { respHeadersObj[k] = v })
        respHeadersObj['x-upstream-status'] = String(up.status)
        const buf = Buffer.from(await up.arrayBuffer())
        res.writeHead(up.status, {
            ...dynamicHeaders,
            'Access-Control-Allow-Origin': req.headers.origin || '*',
            'Access-Control-Allow-Credentials': 'true',
            'Access-Control-Expose-Headers': 'fkn-proxy-headers, Content-Length, Content-Type',
            'Content-Length': buf.length,
            'Content-Type': up.headers.get('content-type') || 'application/octet-stream',
            'fkn-proxy-headers': Buffer.from(JSON.stringify(respHeadersObj), 'utf8').toString('base64'),
        })
        res.end(buf)
    } catch (e) {
        res.writeHead(502); res.end('proxy error: ' + e.message)
    }
}

http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const p = u.pathname

    if (req.method === 'OPTIONS' && p === '/proxy') {
        res.writeHead(204, {
            ...dynamicHeaders,
            'Access-Control-Allow-Origin': req.headers.origin || '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': 'fkn-proxy-protocol, fkn-proxy-hostname, fkn-proxy-pathname, fkn-proxy-search, fkn-proxy-headers, fkn-proxy-render, content-type',
            'Access-Control-Allow-Credentials': 'true',
            'Access-Control-Max-Age': '86400',
        })
        return res.end()
    }
    if (p === '/proxy') {
        return handleProxy(req, res)
    }

    // /playground -> 301 to /playground/ so the HTML's relative script/CSS
    // references resolve under /playground/.
    if (p === '/playground') {
        res.writeHead(301, { Location: '/playground/' + (u.search || '') + (u.hash || '') })
        return res.end()
    }

    let rel = p.replace(/^\//, '') || 'index.html'
    if (rel.endsWith('/')) rel += 'index.html'
    const full = path.normalize(path.join(root, rel))
    if (!full.startsWith(root)) { res.writeHead(403); return res.end() }
    const wasmUrl = '/' + rel
    const immutable = (path.extname(full) === '.wasm' &&
        wasmVersions[wasmUrl] === u.searchParams.get('v')) ||
        /^assets\/.+-[A-Za-z0-9_-]{8,}\.[^/]+$/.test(rel)
    return serveFile(req, res, full, immutable)
}).listen(port, '127.0.0.1', () => {
    console.log('docker-wasm (static + /proxy shim):')
    console.log('  runtime : http://127.0.0.1:' + port + '/?net=webvpn')
    console.log('  drop UI : http://127.0.0.1:' + port + '/playground/')
})
