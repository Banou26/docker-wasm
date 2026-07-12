// Cross-app contracts between the dockerfile-playground drop UI and the
// alpine-curl c2w runtime. Both Vite entries import these constants from
// ./shared so the playground and runtime stay in lockstep.

// URL hash payload the playground produces and the runtime consumes.
// The runtime page resolves `#dockerfile=<base64-utf8>` and pulls each FROM
// reference at boot before auto-pasting a build script into the shell.
export const HASH_KEY_DOCKERFILE = 'dockerfile'

// Search-param contract for the runtime entry. Both apps reference these.
export const QUERY_PARAMS = {
  // c2w network mode: 'delegate' (WebSocket), 'browser' (c2w-net-proxy.wasm),
  // 'webvpn' (c2w-webvpn-proxy.wasm - what the playground uses).
  net: 'net',
  // Path to the container wasm. Playground sets this to /playground/playground.wasm.
  wasmUrl: 'wasm-url',
  // Legacy backend-built mode (resolves to /wasm/<id>/out.wasm).
  wasm: 'wasm',
  publish: 'publish',
  run: 'run',
} as const

export type NetMode = 'delegate' | 'browser' | 'webvpn'

// btoa with UTF-8 safety, trailing-= stripped (browser hash escapes them).
export const b64encodeUtf8 = (s: string): string => {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/=+$/, '')
}

// Inverse of b64encodeUtf8. Re-pads (browser may have stripped trailing '=')
// and decodes through Uint8Array so UTF-8 round-trips.
export const b64decodeUtf8 = (b64: string): string => {
  let padded = b64
  while (padded.length % 4) padded += '='
  const bin = atob(padded)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}
