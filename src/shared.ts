declare const __WASM_ASSET_VERSIONS__: Record<string, string>
declare const __WASM_ASSET_BASE__: string

// Asset responses are immutable for a year, so bump this to move every artifact to a URL nothing has cached: do so when the served bytes are wrong but the R2 objects are right.
export const ASSET_ROUTE_GENERATION = 'g2'

export const withWasmAssetVersion = (url: string): string => {
  const path = url.split('?', 1)[0]!
  const version = __WASM_ASSET_VERSIONS__[path] || 'dev'
  if (__WASM_ASSET_BASE__ && url.startsWith('/') && version !== 'dev' && version !== 'missing') {
    const suffix = url.slice(path.length)
    const versionedPath = path.endsWith('.wasm')
      ? path.slice(0, -5) + '.' + version + '.wasm.js'
      : path + '.' + version
    return __WASM_ASSET_BASE__ + '/' + ASSET_ROUTE_GENERATION + versionedPath + suffix
  }
  const separator = url.includes('?') ? '&' : '?'
  return url + separator + 'v=' + encodeURIComponent(version)
}

// The playground produces and the runtime consumes `#dockerfile=<base64-utf8>`.
export const HASH_KEY_DOCKERFILE = 'dockerfile'

export const QUERY_PARAMS = {
  // c2w network mode: 'delegate' (WebSocket), 'browser' (c2w-net-proxy.wasm), 'webvpn' (c2w-webvpn-proxy.wasm, what the playground uses).
  net: 'net',
  wasmUrl: 'wasm-url',
  wasm: 'wasm',
  publish: 'publish',
  run: 'run',
  arch: 'arch',
} as const

export type NetMode = 'delegate' | 'browser' | 'webvpn'

// Trailing '=' is stripped because the browser escapes it in a hash.
export const b64encodeUtf8 = (s: string): string => {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/=+$/, '')
}

export const b64decodeUtf8 = (b64: string): string => {
  let padded = b64
  while (padded.length % 4) padded += '='
  const bin = atob(padded)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}
