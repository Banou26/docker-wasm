const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { pipeline } = require('node:stream/promises')
const { createGzip, constants } = require('node:zlib')

const root = path.resolve(process.argv[2] || path.join(__dirname, '..', 'build'))

async function assetFiles(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    const files = []
    for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) files.push(...await assetFiles(full))
        if (entry.isFile() && entry.name.endsWith('.wasm')) files.push(full)
    }
    return files
}

async function compress(file) {
    const output = file + '.gz'
    const sourceStat = await fsp.stat(file)
    try {
        const outputStat = await fsp.stat(output)
        if (outputStat.mtimeMs >= sourceStat.mtimeMs && outputStat.size > 0) return
    } catch {}

    const temporary = output + '.tmp'
    await fsp.rm(temporary, { force: true })
    try {
        await pipeline(
            fs.createReadStream(file),
            createGzip({ level: constants.Z_BEST_COMPRESSION }),
            fs.createWriteStream(temporary),
        )
        await fsp.rename(temporary, output)
    } catch (error) {
        await fsp.rm(temporary, { force: true })
        throw error
    }

    const outputStat = await fsp.stat(output)
    const percent = Math.round((1 - outputStat.size / sourceStat.size) * 100)
    console.log(path.relative(root, file) + ': ' + percent + '% smaller with gzip')
}

assetFiles(root)
    .then(async (files) => {
        for (const file of files) await compress(file)
    })
    .catch((error) => {
        console.error('Artifact compression failed:', error)
        process.exitCode = 1
    })
