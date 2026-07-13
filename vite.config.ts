/// <reference types="node" />
import { defineConfig } from 'vite'
import { createReadStream, readFileSync, statSync } from 'node:fs'
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
] as const

const committedWasmAssetVersions = JSON.parse(
  readFileSync(join(process.cwd(), 'wasm-assets.json'), 'utf8'),
) as Record<string, string>
const wasmAssetBase = (process.env.WASM_ASSET_BASE ??
  (process.env.CF_PAGES ? 'https://container-assets.fkn.app' : '')).replace(/\/+$/, '')
const requiredExternalWasmAssets = [
  '/playground/playground.wasm',
  '/c2w-webvpn-proxy.wasm',
]

if (wasmAssetBase) {
  for (const url of requiredExternalWasmAssets) {
    if (!committedWasmAssetVersions[url]) {
      throw new Error('Missing committed WASM version for ' + url)
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

const wasmAssetVersions = Object.fromEntries(await Promise.all(
  wasmAssetFiles.map(async ([url, file]) => [
    url,
    wasmAssetBase
      ? committedWasmAssetVersions[url] || 'missing'
      : await hashAsset(file) || committedWasmAssetVersions[url] || 'missing',
  ] as const),
))

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
