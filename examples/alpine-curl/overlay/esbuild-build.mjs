import * as esbuild from 'esbuild'
await esbuild.build({
  entryPoints: ['webvpn-entry.js'],
  bundle: true,
  format: 'iife',
  outfile: 'webvpn-bundle.js',
  target: 'es2022',
  alias: {
    'node:buffer': 'buffer',
    'node:events': 'events',
    'node:util': 'util',
    'node:stream': 'stream-browserify',
    'node:process': 'process/browser',
    'stream': 'stream-browserify',
  },
  define: {
    'process.env.NODE_ENV': '"production"',
    'global': 'globalThis',
  },
  inject: ['./esbuild-shim.js'],
  logLevel: 'warning',
})
