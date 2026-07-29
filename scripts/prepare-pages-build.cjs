const fsp = require('node:fs/promises')
const path = require('node:path')

const root = path.join(__dirname, '..', 'build')
const externalArtifacts = [
    'out.wasm',
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

// The workers pull the WASI shim in purely for the globals it installs, so a
// build that tree-shakes it produces a site that looks fine and fails at the
// first container start. That happened once, from a blanket
// "sideEffects": false. Fail the build instead of shipping it again.
async function assertWorkerShims(all) {
    const workers = all.filter((file) => /\/assets\/(guest|netstack)\.worker-[^/]+\.js$/.test(file))
    if (workers.length !== 2) {
        throw new Error('expected 2 worker bundles, found ' + workers.length)
    }
    for (const worker of workers) {
        const source = await fsp.readFile(worker, 'utf8')
        if (!source.includes('PreopenDirectory')) {
            throw new Error(
                path.relative(root, worker) + ' is missing the WASI shim. Check the ' +
                '"sideEffects" field in package.json.',
            )
        }
    }
}

async function prepare() {
    for (const relative of externalArtifacts) {
        await fsp.rm(path.join(root, relative), { force: true })
        for (const encoding of ['.gz', '.br']) {
            await fsp.rm(path.join(root, relative + encoding), { force: true })
        }
    }

    const all = await files(root)
    await assertWorkerShims(all)

    for (const file of all) {
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
