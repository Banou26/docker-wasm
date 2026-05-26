// Static server for the in-browser dockerfile playground.
//
// Serves:
//   /playground/         drop UI (web/index.html)
//   /playground/playground.wasm   the c2w-built alpine+buildah image (one-time, ~150 MB)
//   /                    alpine-curl runtime (htdocs/) — buildah builds the user's
//                        Dockerfile inside this guest; the user's Dockerfile is
//                        passed via #dockerfile=<base64> in the URL hash.
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
const htdocs = path.join(here, '..', 'alpine-curl', 'htdocs')
const playgroundWeb = path.join(here, 'web')

const types = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
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

function serveFile(res, full) {
    fs.stat(full, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); return res.end('not found') }
        res.writeHead(200, {
            'Content-Type': types[path.extname(full)] || 'application/octet-stream',
            'Content-Length': st.size,
            ...coiHeaders,
        })
        fs.createReadStream(full).pipe(res)
    })
}

http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const p = u.pathname

    // /playground/* -> the drop UI + playground.wasm
    if (p === '/playground' || p === '/playground/' || p.startsWith('/playground/')) {
        let rel = p.replace(/^\/playground\/?/, '') || 'index.html'
        const full = path.normalize(path.join(playgroundWeb, rel))
        if (!full.startsWith(playgroundWeb)) { res.writeHead(403); return res.end() }
        return serveFile(res, full)
    }

    // / -> alpine-curl runtime
    let rel = p.replace(/^\//, '') || 'index.html'
    const full = path.normalize(path.join(htdocs, rel))
    if (!full.startsWith(htdocs)) { res.writeHead(403); return res.end() }
    return serveFile(res, full)
}).listen(port, '127.0.0.1', () => {
    console.log('dockerfile-playground (static):')
    console.log('  drop UI : http://127.0.0.1:' + port + '/playground/')
    console.log('  runtime : http://127.0.0.1:' + port + '/?net=webvpn&wasm-url=/playground/playground.wasm#dockerfile=<b64>')
})
