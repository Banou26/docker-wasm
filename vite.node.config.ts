/// <reference types="node" />

import { defineConfig } from 'vite'
import { builtinModules } from 'node:module'

export default defineConfig({
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
