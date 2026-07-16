/// <reference types="node" />
import { defineConfig } from 'vite'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { extname, join } from 'node:path'

// COOP/COEP for SharedArrayBuffer + cross-origin iframe (the @fkn/lib RPC iframe
// loads from a different origin and relies on credentialless embedding).
const coiHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'Cross-Origin-Resource-Policy': 'cross-origin',
}

const devHeaders = {
  ...coiHeaders,
  'Cache-Control': 'no-cache',
}

const wasmAssetFiles = [
  ['/playground/playground.wasm', 'public/playground/playground.wasm'],
  ['/c2w-webvpn-proxy.wasm', 'public/c2w-webvpn-proxy.wasm'],
  ['/c2w-net-proxy.wasm', 'public/c2w-net-proxy.wasm'],
  ['/out.wasm', 'public/out.wasm'],
  ['/presets/shell.wasm', 'public/presets/shell.wasm'],
  ['/presets/http.wasm', 'public/presets/http.wasm'],
] as const

const committedWasmAssetVersions = JSON.parse(
  readFileSync(join(process.cwd(), 'wasm-assets.json'), 'utf8'),
) as Record<string, string>
type PresetArtifactRecord = {
  dockerfile: string
  dockerfileSha256: string
  wasmSha256: string
  platform: string
}
type PresetAssetManifest = {
  schemaVersion: number
  container2wasm: { version: string; commit: string }
  artifacts: Record<'shell' | 'http', PresetArtifactRecord>
}
const committedPresetAssets = JSON.parse(
  readFileSync(join(process.cwd(), 'preset-assets.json'), 'utf8'),
) as PresetAssetManifest
const wasmAssetBase = (process.env.WASM_ASSET_BASE ??
  (process.env.CF_PAGES ? '/wasm-assets' : '')).replace(/\/+$/, '')
const requiredExternalWasmAssets = [
  '/playground/playground.wasm',
  '/c2w-webvpn-proxy.wasm',
  '/presets/shell.wasm',
  '/presets/http.wasm',
]
const digestPattern = /^[0-9a-f]{64}$/
const presetSources = {
  shell: 'src/app/dockerfile-playground/presets/shell.Dockerfile',
  http: 'src/app/dockerfile-playground/presets/http.Dockerfile',
} as const
const localPresetFiles = [
  'public/presets/preset-assets.json',
  'public/presets/shell.wasm',
  'public/presets/http.wasm',
]
const localPresetWatchFiles = new Set([
  ...localPresetFiles,
  ...Object.values(presetSources),
].map((file) => join(process.cwd(), file)))

const validatePresetAssets = (
  label: string,
  manifest: PresetAssetManifest,
  versions: Record<string, string>,
): void => {
  if (manifest.schemaVersion !== 1 ||
      manifest.container2wasm.version !== 'v0.8.4' ||
      manifest.container2wasm.commit !== '6ed3d98882a2b22eafc1334f574c364a5b2b8c47') {
    throw new Error(label + ' preset metadata has an invalid converter revision')
  }
  for (const [name, source] of Object.entries(presetSources) as Array<['shell' | 'http', string]>) {
    const record = manifest.artifacts[name]
    const sourceDigest = createHash('sha256').update(readFileSync(join(process.cwd(), source))).digest('hex')
    if (!record || record.dockerfile !== name + '.Dockerfile' || record.platform !== 'linux/amd64' ||
        record.dockerfileSha256 !== sourceDigest || !digestPattern.test(record.wasmSha256) ||
        record.wasmSha256 !== versions['/presets/' + name + '.wasm']) {
      throw new Error(label + ' ' + name + ' preset does not match its canonical source and WASM digest')
    }
  }
}

if (wasmAssetBase) {
  for (const url of requiredExternalWasmAssets) {
    if (!digestPattern.test(committedWasmAssetVersions[url] || '')) {
      throw new Error('Missing or invalid committed asset version for ' + url)
    }
  }
}

const hashAsset = (file: string): Promise<string | null> => new Promise((resolve) => {
  const hash = createHash('sha256')
  const stream = createReadStream(join(process.cwd(), file))
  stream.on('data', (chunk) => hash.update(chunk))
  stream.on('end', () => resolve(hash.digest('hex')))
  stream.on('error', () => resolve(null))
})

const validateLocalPresetFiles = async (): Promise<Record<string, string>> => {
  if (!localPresetFiles.every((file) => existsSync(join(process.cwd(), file)))) {
    throw new Error('Local preset artifacts are incomplete; run npm run build-presets')
  }
  const versions: Record<string, string> = {}
  for (const name of ['shell', 'http'] as const) {
    const digest = await hashAsset('public/presets/' + name + '.wasm')
    if (!digest) throw new Error('Missing local ' + name + ' preset WASM')
    versions['/presets/' + name + '.wasm'] = digest
  }
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), localPresetFiles[0]!), 'utf8'),
  ) as PresetAssetManifest
  validatePresetAssets('Local', manifest, versions)
  return versions
}

const wasmAssetVersions = Object.fromEntries(await Promise.all(
  wasmAssetFiles.map(async ([url, file]) => [
    url,
    wasmAssetBase
      ? committedWasmAssetVersions[url] || 'missing'
      : await hashAsset(file) || committedWasmAssetVersions[url] || 'missing',
  ] as const),
))

if (wasmAssetBase) {
  validatePresetAssets('Committed', committedPresetAssets, wasmAssetVersions)
} else {
  if (!localPresetFiles.every((file) => existsSync(join(process.cwd(), file)))) {
    throw new Error('Local preset artifacts are incomplete; run npm run build-presets')
  }
  const localPresetAssets = JSON.parse(
    readFileSync(join(process.cwd(), localPresetFiles[0]!), 'utf8'),
  ) as PresetAssetManifest
  validatePresetAssets('Local', localPresetAssets, wasmAssetVersions)
}

// Override the @fkn/lib iframe URL before Rollup calculates content hashes.
// Set FKN_API=http://127.0.0.1:1234/api.html for a fully-local fkn/web dev
// server; defaults to the prod URL otherwise.
const fknApi = new URL(process.env.FKN_API || 'https://fkn.app/api')
const fknApiPath = fknApi.pathname + fknApi.search + fknApi.hash

export default defineConfig({
  root: '.',
  publicDir: 'public',
  base: './',
  build: {
    target: 'es2022',
    outDir: 'build',
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        main: 'index.html',
        playground: 'playground/index.html',
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  resolve: {
    alias: {
      'node:buffer': 'buffer',
      'node:events': 'events',
      'node:util': 'util',
      'node:stream': 'stream-browserify',
      'node:process': 'process/browser',
      process: 'process/browser',
      stream: 'stream-browserify',
      util: 'util/',
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    global: 'globalThis',
    __WASM_ASSET_BASE__: JSON.stringify(wasmAssetBase),
    __WASM_ASSET_VERSIONS__: JSON.stringify(wasmAssetVersions),
  },
  server: {
    headers: devHeaders,
  },
  preview: {
    headers: devHeaders,
  },
  plugins: [
    {
      name: 'validate-local-presets',
      buildStart: async function () {
        if (wasmAssetBase) return
        for (const file of localPresetWatchFiles) this.addWatchFile(file)
        const currentVersions = await validateLocalPresetFiles()
        for (const name of ['shell', 'http'] as const) {
          const path = '/presets/' + name + '.wasm'
          if (currentVersions[path] !== wasmAssetVersions[path]) {
            throw new Error('Local preset digests changed; restart the Vite build watch')
          }
        }
      },
      configureServer: (server) => {
        if (wasmAssetBase) return
        let restartTimer: ReturnType<typeof setTimeout> | null = null
        let validationGeneration = 0
        let validationError: Error | null = null

        server.middlewares.use((_request, response, next) => {
          if (!validationError) return next()
          response.statusCode = 503
          response.setHeader('Content-Type', 'text/plain; charset=utf-8')
          response.end(validationError.message + '\n')
        })
        server.watcher.add([...localPresetWatchFiles])
        server.watcher.on('all', (_event, file) => {
          if (!localPresetWatchFiles.has(file)) return
          const generation = ++validationGeneration
          if (restartTimer) clearTimeout(restartTimer)
          restartTimer = setTimeout(() => {
            void validateLocalPresetFiles().then(async () => {
              if (generation !== validationGeneration) return
              validationError = null
              await server.restart()
            }, (error: unknown) => {
              if (generation !== validationGeneration) return
              validationError = error instanceof Error ? error : new Error(String(error))
              server.config.logger.error(validationError.message, { timestamp: true })
            })
          }, 300)
        })
      },
      handleHotUpdate: (context) => {
        if (!wasmAssetBase && localPresetWatchFiles.has(context.file)) return []
      },
    },
    {
      name: 'fkn-api-url',
      enforce: 'pre',
      transform: (code, id) => {
        const normalizedId = id.replaceAll('\\', '/')
        if (!normalizedId.includes('/node_modules/@fkn/lib/')) return null
        let rewritten = code.replaceAll('https://fkn.app', fknApi.origin)
        if (/\/api-[^/]+\.js$/.test(normalizedId)) {
          rewritten = rewritten.replace(/(\$\{[A-Za-z_$][\w$]*\})\/api(?=[`"])/g, '$1' + fknApiPath)
        }
        return rewritten === code ? null : { code: rewritten, map: null }
      },
    },
    {
      name: 'emit-wasm-versions',
      generateBundle: function () {
        this.emitFile({
          type: 'asset',
          fileName: 'wasm-versions.json',
          source: JSON.stringify(wasmAssetVersions),
        })
      },
    },
    {
      // Serve dist/* raw during dev (the Go-wasm artifact lands there before
      // make's copy step propagates it into public/). Mirrors libav-wasm.
      name: 'serve-dist-raw',
      configureServer: (server) => {
        server.middlewares.use('/dist', (req, res, next) => {
          const filePath = join(process.cwd(), 'dist', (req.url || '/').split('?')[0] || '/')
          try {
            const stat = statSync(filePath)
            if (!stat.isFile()) return next()
            const ext = extname(filePath)
            const type = ext === '.wasm' ? 'application/wasm'
              : ext === '.js' ? 'text/javascript'
              : 'application/octet-stream'
            res.setHeader('Content-Type', type)
            res.setHeader('Content-Length', String(stat.size))
            res.setHeader('Cache-Control', 'public, max-age=300')
            createReadStream(filePath).pipe(res)
          } catch { next() }
        })
      },
    },
  ],
})
