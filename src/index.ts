// Library entry - re-exports the in-browser pieces of the c2w-webvpn stack so
// embedders can wire the netstack into their own c2w runtime.
//
// The Go-wasm proxy in src/proxy/ is the egress kernel; this JS layer is what
// drives it from the main thread.

export { newStack } from './stack'
export type { Netstack, ImageCache, ImageCacheEntry, PublishedTCPPort } from './webvpn-netstack'
export { createWebvpnNetstack } from './webvpn-netstack'
export { pullImage, parseRef, dockerfileFromRefs } from './registry'
export type { Platform, PullOptions } from './registry'
export {
  HASH_KEY_DOCKERFILE,
  QUERY_PARAMS,
  b64encodeUtf8,
  b64decodeUtf8,
} from './shared'
export type { NetMode } from './shared'
