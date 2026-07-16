const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const root = path.join(__dirname, '..')
const manifestPath = path.join(root, 'wasm-assets.json')
const assets = {
    '/playground/playground.wasm': 'playground/playground.wasm',
    '/c2w-webvpn-proxy.wasm': 'c2w-webvpn-proxy.wasm',
    '/presets/shell.wasm': 'presets/shell.wasm',
    '/presets/http.wasm': 'presets/http.wasm',
}
const args = process.argv.slice(2)
const sourceRootIndex = args.indexOf('--source-root')
let sourceRoot = path.join(root, 'public')
if (sourceRootIndex !== -1) {
    if (!args[sourceRootIndex + 1]) throw new Error('--source-root requires a directory path')
    sourceRoot = path.resolve(args[sourceRootIndex + 1])
    args.splice(sourceRootIndex, 2)
}
const outputIndex = args.indexOf('--output')
let outputPath = manifestPath
if (outputIndex !== -1) {
    if (!args[outputIndex + 1]) throw new Error('--output requires a file path')
    outputPath = path.resolve(args[outputIndex + 1])
    args.splice(outputIndex, 2)
}
if (args.length === 0) {
    throw new Error('Pass at least one manifest asset path to update')
}

const versions = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

for (const url of args) {
    const relativePath = assets[url]
    if (!relativePath) throw new Error('Unknown artifact: ' + url)
    const file = path.join(sourceRoot, relativePath)
    if (!fs.existsSync(file)) throw new Error('Missing artifact: ' + relativePath)
    versions[url] = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

const temporaryPath = outputPath + '.tmp-' + process.pid
fs.writeFileSync(temporaryPath, JSON.stringify(versions, null, 2) + '\n')
fs.renameSync(temporaryPath, outputPath)
