// `postMessage` has a different signature in the DOM and WebWorker lib files,
// and the library compiles against both. Route worker sends through one typed
// helper so neither overload leaks into the call sites.

type WorkerPostMessage = (message: unknown, transfer?: Transferable[]) => void

export const post = (message: unknown, transfer?: Transferable[]): void => {
  const send = (globalThis as unknown as { postMessage: WorkerPostMessage }).postMessage
  if (transfer && transfer.length > 0) send(message, transfer)
  else send(message)
}
