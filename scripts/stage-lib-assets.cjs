// Puts the network stack module where the library build can see it.
//
// src/lib/container.ts resolves the default with
// `new URL('./c2w-webvpn-proxy.wasm', import.meta.url)`. Vite only turns that
// into an emitted asset when the file is actually next to the source, so the
// Go artifact is copied in before the build and stays gitignored.

const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const name = 'c2w-webvpn-proxy.wasm'
const candidates = [path.join(root, 'dist', name), path.join(root, 'public', name)]
const destination = path.join(root, 'src', 'lib', name)

if (process.argv.includes('--clean')) {
    // Removed again after the library build. Left in place, it would also be
    // emitted into the demo site's bundle, which passes its own copy explicitly.
    fs.rmSync(destination, { force: true })
    console.log('removed src/lib/' + name)
    process.exit(0)
}

const source = candidates.find((candidate) => fs.existsSync(candidate))
if (!source) {
    console.error(
        'Missing ' + name + '. Build it first with `npm run make-docker`, which writes it to dist/.',
    )
    process.exit(1)
}

fs.copyFileSync(source, destination)
const { size } = fs.statSync(destination)
console.log('staged ' + path.relative(root, source) + ' -> src/lib/' + name +
    ' (' + (size / 1e6).toFixed(1) + ' MB)')
