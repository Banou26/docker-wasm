/// <reference types="node" />
import { defineConfig } from 'vite'
import { createReadStream, statSync } from 'node:fs'
import { extname, join } from 'node:path'

// COOP/COEP for SharedArrayBuffer + cross-origin iframe (the @fkn/lib RPC iframe
// loads from a different origin and relies on credentialless embedding).
const coiHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Cache-Control': 'no-store',
}

// Used at runtime to override the @fkn/lib iframe origin baked into the bundle.
// Set FKN_API=http://127.0.0.1:1234/api.html for a fully-local fkn/web dev
// server; defaults to the prod URL otherwise.
const fknApi = process.env.FKN_API || 'https://fkn.app/api'

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
        entryFileNames: 'assets/[name].js',
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
    __FKN_API__: JSON.stringify(fknApi),
  },
  server: {
    headers: coiHeaders,
  },
  preview: {
    headers: coiHeaders,
  },
  plugins: [
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
