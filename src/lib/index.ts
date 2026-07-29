// Run a Docker image in a browser tab and make HTTP requests to it.
//
//   import { createContainer } from '@fkn/container'
//   import image from './api/Dockerfile?container'
//
//   const api = createContainer({ image, ports: [8080] })
//   const response = await api.fetch('/health')
//   console.log(response.status, await response.json())
//
// The page needs cross-origin isolation for SharedArrayBuffer. The Vite plugin
// sets the headers in dev; see `assertCrossOriginIsolated` for production.

export { Container, createContainer } from './container'
export type {
  ContainerImage,
  ContainerOptions,
  ContainerPort,
  ContainerStatus,
} from './container'

export { HttpClient, HttpError } from './http'
export type { HttpClientOptions, HttpEndpoint } from './http'

export { createNetstack } from './netstack'
export type {
  ArtifactCache,
  ArtifactCacheEntry,
  Netstack,
  NetstackOptions,
  PublishedPort,
} from './netstack'

export { TtyHost } from './tty-host'
export type { Termios, TtyHostOptions } from './tty-host'

// Downloads and compiles an image ahead of time so a later `createContainer`
// starts from a warm HTTP and code cache. Safe to call more than once.
export const preloadContainer = async (image: string | URL): Promise<void> => {
  const url = typeof image === 'string' ? image : image.href
  const response = await fetch(url, { credentials: 'same-origin', cache: 'force-cache' })
  if (!response.ok) throw new Error('preload failed: HTTP ' + response.status + ' for ' + url)
  const type = (response.headers.get('content-type') || '').toLowerCase()
  if (type.includes('application/wasm')) {
    // Compiling here, rather than only downloading, is what populates the
    // engine's code cache for the real start.
    await WebAssembly.compileStreaming(response)
    return
  }
  await response.arrayBuffer()
}

// SharedArrayBuffer, and therefore the whole runtime, needs the document to be
// cross-origin isolated. Call this to turn a confusing downstream failure into
// a clear one.
//
// The two ways this fails look identical from the outside but have completely
// different fixes, so they are reported separately. Headers missing is the
// server's problem. Headers present but isolation still off is the visitor's
// browser: an extension rewriting response headers, or a disabled preference.
export const assertCrossOriginIsolated = (): void => {
  if (globalThis.crossOriginIsolated) return

  const sabMissing = typeof SharedArrayBuffer === 'undefined'
  const detail = sabMissing
    ? 'Serve this page with "Cross-Origin-Opener-Policy: same-origin" and ' +
      '"Cross-Origin-Embedder-Policy: credentialless" (or "require-corp").'
    : 'SharedArrayBuffer exists but the document is not isolated, so the headers are ' +
      'probably being sent and then altered. Check for a browser extension that rewrites ' +
      'response headers, and for a disabled cross-origin isolation preference. ' +
      'A clean browser profile is the quickest way to tell the two apart.'

  throw new Error('This page is not cross-origin isolated. ' + detail)
}
