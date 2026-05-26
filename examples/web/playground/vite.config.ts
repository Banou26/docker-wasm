/// <reference types="node" />
import { defineConfig } from 'vite'

const coiHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Cache-Control': 'no-store',
}

export default defineConfig({
  root: '.',
  publicDir: 'public',
  // The playground is served under /playground/ by the runtime's static server;
  // emit relative asset URLs so the bundled <script src="..."> resolves there.
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  server: { headers: coiHeaders },
  preview: { headers: coiHeaders },
})
