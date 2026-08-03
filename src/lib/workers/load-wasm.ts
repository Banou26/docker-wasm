// Chrome only populates its WebAssembly code cache for modules compiled through the streaming entry points.

import type { WorkerStage } from '../protocol'
import { post } from './post'

export type WasmSource = string | ArrayBuffer

const report = (stage: WorkerStage, startedAt: number, bytes?: number): void => {
  post({ type: 'status', stage, elapsedMs: Math.round(performance.now() - startedAt), bytes })
}

export const instantiate = async (
  source: WasmSource,
  imports: WebAssembly.Imports,
): Promise<WebAssembly.Instance> => {
  const startedAt = performance.now()

  if (typeof source !== 'string') {
    const result = await WebAssembly.instantiate(source, imports)
    report('compiled', startedAt, source.byteLength)
    return result.instance
  }

  const response = await fetch(source, { credentials: 'same-origin' })
  if (!response.ok) {
    throw new Error('container image request failed: HTTP ' + response.status + ' for ' + source)
  }
  const declared = Number(response.headers.get('content-length'))
  report('fetching', startedAt, Number.isFinite(declared) && declared > 0 ? declared : undefined)

  const contentType = (response.headers.get('content-type') || '').toLowerCase()
  if (contentType.includes('application/wasm')) {
    const result = await WebAssembly.instantiateStreaming(response, imports)
    report('compiled', startedAt)
    return result.instance
  }

  console.warn(
    '[fkn-container] ' + source + ' was served as "' + (contentType || 'no content type') +
    '". Serve it as application/wasm for streaming compilation.',
  )
  const bytes = await response.arrayBuffer()
  const result = await WebAssembly.instantiate(bytes, imports)
  report('compiled', startedAt, bytes.byteLength)
  return result.instance
}
