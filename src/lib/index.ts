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

export const preloadContainer = async (image: string | URL): Promise<void> => {
  const url = typeof image === 'string' ? image : image.href
  const response = await fetch(url, { credentials: 'same-origin', cache: 'force-cache' })
  if (!response.ok) throw new Error('preload failed: HTTP ' + response.status + ' for ' + url)
  const type = (response.headers.get('content-type') || '').toLowerCase()
  if (type.includes('application/wasm')) {
    // Compiling, rather than only downloading, is what populates the engine's code cache for the real start.
    await WebAssembly.compileStreaming(response)
    return
  }
  await response.arrayBuffer()
}

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
