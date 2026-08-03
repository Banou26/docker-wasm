type WorkerPostMessage = (message: unknown, transfer?: Transferable[]) => void

export const post = (message: unknown, transfer?: Transferable[]): void => {
  const send = (globalThis as unknown as { postMessage: WorkerPostMessage }).postMessage
  if (transfer && transfer.length > 0) send(message, transfer)
  else send(message)
}
