// Relays Ethernet frames between the guest worker and the netstack worker.
//
// Neither worker can talk to the other directly: both are blocked inside a
// synchronous WASI program whenever they have something to say. The main thread
// owns one buffer per worker and copies between them, so each side's send lands
// in the other side's receive queue. Requests the netstack worker makes for
// real egress are forwarded to the Netstack.

import { STREAM_BUFFER_BYTES, viewStream, type StreamView } from './protocol'
import type { Netstack, NetstackRequest } from './netstack'

// Frames arrive one at a time and leave in 64 KiB windows, so the queue keeps
// a chunk list rather than one growing buffer. Concatenating on every frame
// makes the relay quadratic in the size of a burst, which shows up as stalls
// exactly when the guest is busiest.
class Queue {
  private chunks: Uint8Array[] = []
  private pending = 0
  wake: (() => void) | null = null

  get length (): number { return this.pending }

  push (chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return
    this.chunks.push(chunk)
    this.pending += chunk.byteLength
  }

  // Fills `into` with up to `limit` bytes and returns how many were written.
  drainInto (into: Uint8Array, limit: number): number {
    const want = Math.min(limit, into.byteLength, this.pending)
    let written = 0
    while (written < want) {
      const chunk = this.chunks[0]!
      const take = Math.min(chunk.byteLength, want - written)
      into.set(chunk.subarray(0, take), written)
      if (take === chunk.byteLength) this.chunks.shift()
      else this.chunks[0] = chunk.subarray(take)
      this.pending -= take
      written += take
    }
    return written
  }
}

class Endpoint {
  readonly buffer: SharedArrayBuffer
  private view: StreamView
  private accepted = false
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private waiting = false

  constructor (
    private label: string,
    private send: Queue,
    private receive: Queue,
    private netstack: () => Netstack | null,
  ) {
    this.buffer = new SharedArrayBuffer(STREAM_BUFFER_BYTES)
    this.view = viewStream(this.buffer)
    receive.wake = () => this.releasePoll()
  }

  private reply (): void {
    Atomics.store(this.view.control, 0, 1)
    Atomics.notify(this.view.control, 0)
  }

  private releasePoll (): void {
    if (!this.waiting) return
    this.waiting = false
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    this.view.data[0] = 1
    this.view.status[0] = 0
    this.reply()
  }

  // Moves up to `length` bytes out of the queue into the shared window.
  private drain (queue: Queue, length: number): void {
    this.view.length[0] = queue.drainInto(this.view.data, length)
  }

  handle (message: MessageEvent): void {
    const request = message.data as { type?: string } & Record<string, never>
    if (typeof request?.type !== 'string') return

    if (request.type.startsWith('webvpn_')) {
      const netstack = this.netstack()
      if (!netstack) {
        this.view.status[0] = -1
        this.reply()
        return
      }
      // Sync handlers return true after writing their reply; async ones return
      // a promise and write theirs when it settles.
      Promise.resolve()
        .then(async () => { await netstack.handle(request as unknown as NetstackRequest, this.view) })
        .catch((error: unknown) => {
          console.warn('[fkn-container] ' + this.label + ' egress request failed:', error)
          this.view.status[0] = -1
        })
        .then(() => this.reply())
      return
    }

    switch (request.type) {
      case 'accept':
        this.accepted = true
        this.view.data[0] = 1
        this.view.status[0] = 0
        break
      case 'send':
        if (!this.accepted) {
          this.view.status[0] = -1
          break
        }
        this.send.push(request.buf as unknown as Uint8Array)
        this.send.wake?.()
        this.view.status[0] = 0
        break
      case 'recv':
        if (!this.accepted) {
          this.view.status[0] = -1
          break
        }
        this.drain(this.receive, request.len as unknown as number)
        this.view.status[0] = 0
        break
      case 'recv-is-readable': {
        this.view.status[0] = 0
        if (this.receive.length > 0) {
          this.view.data[0] = 1
          break
        }
        const timeout = request.timeout as unknown as number | undefined
        const timeoutMs = timeout === undefined ? 0 : timeout * 1000
        if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) {
          this.view.data[0] = 0
          break
        }
        this.waiting = true
        this.pollTimer = setTimeout(() => {
          this.pollTimer = null
          this.waiting = false
          this.view.data[0] = this.receive.length > 0 ? 1 : 0
          this.view.status[0] = 0
          this.reply()
        }, Math.min(timeoutMs, 0x7fffffff))
        return
      }
      default:
        console.warn('[fkn-container] ' + this.label + ' sent an unknown request: ' + request.type)
        return
    }
    this.reply()
  }

  dispose (): void {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
    this.waiting = false
    this.receive.wake = null
  }
}

export class FrameBridge {
  private guestEndpoint: Endpoint
  private netstackEndpoint: Endpoint

  constructor (netstack: () => Netstack | null, onGuestReadable?: () => void) {
    const toGuest = new Queue()
    const toNetstack = new Queue()
    this.guestEndpoint = new Endpoint('guest', toNetstack, toGuest, netstack)
    this.netstackEndpoint = new Endpoint('netstack', toGuest, toNetstack, netstack)
    if (onGuestReadable) {
      // The endpoint's own wake releases a parked frame poll. The guest may
      // instead be parked on its console, so the runtime gets told as well.
      const release = toGuest.wake
      toGuest.wake = () => {
        release?.()
        onGuestReadable()
      }
    }
  }

  get guestBuffer (): SharedArrayBuffer { return this.guestEndpoint.buffer }
  get netstackBuffer (): SharedArrayBuffer { return this.netstackEndpoint.buffer }

  handleGuest (message: MessageEvent): void { this.guestEndpoint.handle(message) }
  handleNetstack (message: MessageEvent): void { this.netstackEndpoint.handle(message) }

  dispose (): void {
    this.guestEndpoint.dispose()
    this.netstackEndpoint.dispose()
  }
}
