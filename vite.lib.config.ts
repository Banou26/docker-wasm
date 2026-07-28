/// <reference types="node" />
// Browser half of the published package: the runtime, its two module workers,
// and the network stack module they load.
//
// Deliberately not Vite's `build.lib` mode. That mode inlines every emitted
// asset as base64 regardless of `assetsInlineLimit`, which would turn the 16 MB
// network stack into a 22 MB string inside the entry chunk: no streaming
// compilation, no code cache, and a 22 MB parse on every import.

import { defineConfig } from 'vite'

export default defineConfig({
  // Relative, so `lib/index.js` finds its assets wherever the package is
  // installed.
  base: './',
  // The demo site's static files are not part of the package.
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
      // The transport stays external so a consumer resolves one copy of it.
      // Everything else, including the Node shims the transport reaches for,
      // is bundled so installing the package is enough.
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
