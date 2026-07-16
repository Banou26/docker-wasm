const fs = require('node:fs')

const file = process.argv[2]
if (!file) throw new Error('Pass a WebAssembly artifact path')

const bytes = fs.readFileSync(file)
if (bytes.length < 10 * 1024 * 1024) {
    throw new Error(file + ' is too small to contain a c2w runtime')
}

const wasmModule = new WebAssembly.Module(bytes)
const exportNames = new Set(WebAssembly.Module.exports(wasmModule).map((entry) => entry.name))
for (const name of ['memory', '_start', 'asyncify_start_unwind', 'asyncify_start_rewind']) {
    if (!exportNames.has(name)) throw new Error(file + ' is missing c2w export ' + name)
}

const imports = WebAssembly.Module.imports(wasmModule)
for (const name of ['fd_read', 'fd_write', 'poll_oneoff']) {
    if (!imports.some((entry) => entry.module === 'wasi_snapshot_preview1' && entry.name === name)) {
        throw new Error(file + ' is missing WASI import ' + name)
    }
}
