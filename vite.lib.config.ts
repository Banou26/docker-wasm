/// <reference types="node" />
// deliberately not Vite's `build.lib` mode: it inlines every emitted asset as base64 regardless of `assetsInlineLimit`

import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  publicDir: false,
  build: {
    target: 'es2022',
    outDir: 'lib',
    assetsDir: 'assets',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    modulePreload: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: { index: 'src/lib/index.ts' },
      external: [/^@fkn\/lib(\/|$)/],
      preserveEntrySignatures: 'exports-only',
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  worker: {
    format: 'es',
    rollupOptions: {
      external: [/^@fkn\/lib(\/|$)/],
    },
  },
  resolve: {
    alias: [
      { find: /^node:buffer$/, replacement: 'buffer' },
      { find: /^node:events$/, replacement: 'events' },
      { find: /^node:util$/, replacement: 'util/' },
      { find: /^node:stream$/, replacement: 'stream-browserify' },
      { find: /^node:process$/, replacement: 'process/browser.js' },
      { find: /^process$/, replacement: 'process/browser.js' },
      { find: /^stream$/, replacement: 'stream-browserify' },
      { find: /^util$/, replacement: 'util/' },
    ],
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    global: 'globalThis',
  },
})
