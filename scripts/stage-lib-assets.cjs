// Vite only turns src/lib/container.ts's `new URL('./c2w-webvpn-proxy.wasm', import.meta.url)` into an emitted asset when the file is actually next to the source.

const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const name = 'c2w-webvpn-proxy.wasm'
const candidates = [path.join(root, 'dist', name), path.join(root, 'public', name)]
const destination = path.join(root, 'src', 'lib', name)

// Removed again after the library build: left in place it would also be emitted into the demo site's bundle, which passes its own copy explicitly.
if (process.argv.includes('--clean')) {
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
