// the browser build of Node's stream API reaches for a global `process` at runtime, so without this the first `socket.resume()` throws

import nodeProcess from 'process/browser.js'

type MinimalProcess = { nextTick?: (callback: (...args: unknown[]) => void, ...args: unknown[]) => void }

const existing = (globalThis as { process?: MinimalProcess }).process
if (typeof existing?.nextTick !== 'function') {
  Object.assign(globalThis, { process: Object.assign({}, existing, nodeProcess) })
}

export {}
