const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { pipeline } = require('node:stream/promises')
const zlib = require('node:zlib')

const root = path.resolve(process.argv[2] || path.join(__dirname, '..', 'build'))

const encodings = [
    {
        extension: '.br',
        label: 'brotli',
        // quality 9 rather than 11: on a 54 MB artifact the last two levels cost minutes for a couple of percent
        stream: (size) => zlib.createBrotliCompress({
            params: {
                [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
                [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
                [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size,
            },
        }),
    },
    {
        extension: '.gz',
        label: 'gzip',
        stream: () => zlib.createGzip({ level: zlib.constants.Z_BEST_COMPRESSION }),
    },
]

async function assetFiles (dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    const files = []
    for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) files.push(...await assetFiles(full))
        if (entry.isFile() && entry.name.endsWith('.wasm')) files.push(full)
    }
    return files
}

async function compress (file, encoding, sourceStat) {
    const output = file + encoding.extension
    try {
        const outputStat = await fsp.stat(output)
        if (outputStat.mtimeMs >= sourceStat.mtimeMs && outputStat.size > 0) return
    } catch {}

    const temporary = output + '.tmp'
    await fsp.rm(temporary, { force: true })
    try {
        await pipeline(
            fs.createReadStream(file),
            encoding.stream(sourceStat.size),
            fs.createWriteStream(temporary),
        )
        await fsp.rename(temporary, output)
    } catch (error) {
        await fsp.rm(temporary, { force: true })
        throw error
    }

    const outputStat = await fsp.stat(output)
    const percent = Math.round((1 - outputStat.size / sourceStat.size) * 100)
    console.log(
        path.relative(root, file) + ': ' + (outputStat.size / 1e6).toFixed(1) + ' MB with ' +
        encoding.label + ', ' + percent + '% smaller',
    )
}

assetFiles(root)
    .then(async (files) => {
        for (const file of files) {
            const sourceStat = await fsp.stat(file)
            for (const encoding of encodings) await compress(file, encoding, sourceStat)
        }
    })
    .catch((error) => {
        console.error('Artifact compression failed:', error)
        process.exitCode = 1
    })
