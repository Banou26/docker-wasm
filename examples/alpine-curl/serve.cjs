// Tiny static server for htdocs with the COOP/COEP headers required for
// SharedArrayBuffer.
const http = require('http')
const fs = require('fs')
const path = require('path')
const root = path.join(__dirname, 'htdocs')
const port = parseInt(process.env.PORT || '8080', 10)
const types = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.cjs':  'application/javascript; charset=utf-8',
    '.mjs':  'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.css':  'text/css; charset=utf-8',
    '.conf': 'text/plain; charset=utf-8',
}
http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0])
    if (p === '/') p = '/index.html'
    const full = path.normalize(path.join(root, p))
    if (!full.startsWith(root)) { res.writeHead(403); return res.end() }
    fs.stat(full, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); return res.end('not found: ' + p) }
        res.writeHead(200, {
            'Content-Type': types[path.extname(full)] || 'application/octet-stream',
            'Content-Length': st.size,
            'Cross-Origin-Opener-Policy': 'same-origin',
            // credentialless allows cross-origin iframes (e.g., @fkn/lib's
            // https://fkn.app/api bridge) while still giving SharedArrayBuffer.
            'Cross-Origin-Embedder-Policy': 'credentialless',
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'Cache-Control': 'no-store',
        })
        fs.createReadStream(full).pipe(res)
    })
}).listen(port, '127.0.0.1', () => {
    console.log('serving ' + root + ' at http://127.0.0.1:' + port + '/  (COOP/COEP enabled)')
})
