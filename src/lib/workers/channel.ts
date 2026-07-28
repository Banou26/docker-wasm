// Worker side of the SharedArrayBuffer request channel.
//
// Every call posts a message and parks the worker thread on Atomics.wait until
// the main thread fills in the reply. The guest and netstack WASM modules are
// synchronous WASI programs, so blocking here is the only way to give them a
// socket API without Asyncify.

import { viewStream, type StreamView } from '../protocol'
import { post } from './post'

export class Channel {
  private view: StreamView

  constructor (shared: SharedArrayBuffer) {
    this.view = viewStream(shared)
  }

  get data (): Uint8Array { return this.view.data }
  get status (): number { return this.view.status[0]! }
  get length (): number { return this.view.length[0]! }

  request (message: Record<string, unknown>, transfer?: Transferable[]): number {
    const control = this.view.control
    Atomics.store(control, 0, 0)
    post(message, transfer)
    Atomics.wait(control, 0, 0)
    return this.view.status[0]!
  }

  // Copies the reply payload out of the shared window. The caller must copy
  // before issuing the next request, because the window is reused.
  payload (): Uint8Array {
    return this.view.data.slice(0, this.view.length[0]!)
  }
}
