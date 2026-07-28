// Worker side of the pseudo-terminal channel.
//
// Same wire format xterm-pty's TtyClient uses, reimplemented here so the
// library's workers stay plain ES modules with no UMD bundle to load. The
// buffer holds a control word followed by an Int32 payload array.

import type { TtyRequest } from '../protocol'
import { post } from './post'

export class TtyClient {
  private control: Int32Array
  private payload: Int32Array

  constructor (shared: SharedArrayBuffer) {
    this.control = new Int32Array(shared, 0, 1)
    this.payload = new Int32Array(shared, 4)
  }

  private request (message: TtyRequest): void {
    Atomics.store(this.control, 0, 0)
    post(message)
    Atomics.wait(this.control, 0, 0)
  }

  onRead (length?: number): number[] {
    const want = length ?? this.payload.length - 1
    this.request({ ttyRequestType: 'read', length: want })
    const count = this.payload[0]!
    return Array.from(this.payload.slice(1, count + 1))
  }

  onWrite (bytes: number[]): void {
    this.request({ ttyRequestType: 'write', buf: bytes })
  }

  onWaitForReadable (timeoutSeconds: number): boolean {
    this.request({ ttyRequestType: 'poll', timeout: timeoutSeconds })
    return this.payload[0] === 1
  }

  onIoctlTcgets (): number[] {
    this.request({ ttyRequestType: 'tcgets' })
    return Array.from(this.payload.slice(0, 13))
  }

  onIoctlTcsets (data: number[]): void {
    this.request({ ttyRequestType: 'tcsets', data })
  }

  // Returns [rows, cols].
  onIoctlTiocgwinsz (): [number, number] {
    this.request({ ttyRequestType: 'tiocgwinsz' })
    return [this.payload[0]!, this.payload[1]!]
  }
}
