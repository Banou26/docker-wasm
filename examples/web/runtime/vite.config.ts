/// <reference types="node" />
import { defineConfig } from 'vite'

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
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        // Predictable filenames so we can deep-link them from worker-side code.
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
      stream: 'stream-browserify',
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
})
