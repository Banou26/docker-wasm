const fsp = require('node:fs/promises')
const path = require('node:path')

const root = path.join(__dirname, '..', 'build')
const externalArtifacts = [
    'out.wasm',
    'c2w-net-proxy.wasm',
    'c2w-webvpn-proxy.wasm',
    'playground/playground.wasm',
    'presets/shell.wasm',
    'presets/http.wasm',
    'presets/preset-assets.json',
]
const maximumFileSize = 25 * 1024 * 1024

async function files(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    const result = []
    for (const entry of entries) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) result.push(...await files(file))
        if (entry.isFile()) result.push(file)
    }
    return result
}

async function prepare() {
    for (const relative of externalArtifacts) {
        await fsp.rm(path.join(root, relative), { force: true })
        await fsp.rm(path.join(root, relative + '.gz'), { force: true })
    }

    for (const file of await files(root)) {
        const size = (await fsp.stat(file)).size
        if (size > maximumFileSize) {
            throw new Error(path.relative(root, file) + ' exceeds the Cloudflare Pages file limit')
        }
    }
}

prepare().catch((error) => {
    console.error('Pages build preparation failed:', error)
    process.exitCode = 1
})
