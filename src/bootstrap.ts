import process from 'process'

const runtimeParams = new URLSearchParams(location.search)
const hasRuntimeRequest = ['net', 'wasm-url', 'wasm'].some((name) => runtimeParams.has(name))

if (location.pathname === '/' && !hasRuntimeRequest) {
  location.replace('/playground/')
} else {
  Object.assign(globalThis, { process })
  void import('./main')
}
