/// <reference types="node" />
// Node half of the published package: the Vite plugin and the CLI.

import { defineConfig } from 'vite'
import { builtinModules } from 'node:module'

export default defineConfig({
  // The demo site's static files are not part of the package.
  publicDir: false,
  build: {
    target: 'node20',
    outDir: 'lib/vite',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    ssr: true,
    lib: {
      entry: {
        index: 'src/vite/index.ts',
        cli: 'src/vite/cli.ts',
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: [
        'vite',
        ...builtinModules,
        ...builtinModules.map((name) => 'node:' + name),
      ],
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name]-[hash].js',
      },
    },
  },
})
