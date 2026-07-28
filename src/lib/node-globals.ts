// The FKN transport is published against Node's stream API, and the browser
// build of that API reaches for a global `process` at runtime rather than
// importing one. Without it, the first `socket.resume()` throws
// "process.nextTick is not a function" and every flow through the netstack
// stalls.
//
// Installing it here, from a module both the netstack and the HTTP client
// import first, keeps the fix inside the library instead of making it a
// consumer's setup step.

import nodeProcess from 'process/browser.js'

type MinimalProcess = { nextTick?: (callback: (...args: unknown[]) => void, ...args: unknown[]) => void }

const existing = (globalThis as { process?: MinimalProcess }).process
if (typeof existing?.nextTick !== 'function') {
  Object.assign(globalThis, { process: Object.assign({}, existing, nodeProcess) })
}

export {}
