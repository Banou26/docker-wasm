// Main-thread half of the guest console.
//
// The guest is a blocked WASI program: every console read, write, and ioctl is
// a SharedArrayBuffer round-trip it cannot proceed past. This host answers each
// one and, for a read poll with no data pending, parks the reply until input
// arrives or the guest's own timeout expires. Parking rather than busy-polling
// is what keeps an idle container off the CPU.

import { TTY_BUFFER_BYTES, type TtyRequest } from './protocol'

// Raw mode: the guest runs its own line discipline, so nothing is translated
// or echoed on the way through. Matches the flags a terminal integration would
// set with TCSETS immediately after boot.
const IMAXBEL = 8192
const IUTF8 = 16384
const ONLCR = 4
const ECHOE = 16
const ECHOK = 32
const ECHOCTL = 512
const ECHOKE = 2048

const DEFAULT_CC = [3, 28, 127, 21, 4, 0, 1, 0, 17, 19, 26, 0, 18, 15, 23, 22,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]

export type Termios = {
  iflag: number
  oflag: number
  cflag: number
  lflag: number
  cc: number[]
}

const defaultTermios = (): Termios => ({
  iflag: IMAXBEL | IUTF8,
  oflag: ONLCR,
  cflag: 191,
  lflag: ECHOE | ECHOK | ECHOCTL | ECHOKE,
  cc: DEFAULT_CC.slice(),
})

// xterm-pty's packing: four flag words, then the 32 control characters packed
// one byte at a time starting at bit 8 of the fifth word.
const encodeTermios = (termios: Termios): number[] => {
  const out = [termios.iflag, termios.oflag, termios.cflag, termios.lflag]
  let word = 0
  let shift = 8
  for (const value of termios.cc) {
    word |= value << shift
    shift += 8
    if (shift === 32) {
      out.push(word)
      word = 0
      shift = 0
    }
  }
  out.push(word)
  return out
}

const decodeTermios = (data: number[]): Termios => {
  const cc: number[] = []
  let index = 4
  let word = data[index++] || 0
  let shift = 8
  for (let position = 0; position < 32; position++) {
    cc.push((word >> shift) & 0xff)
    shift += 8
    if (shift >= 32) {
      word = data[index++] || 0
      shift = 0
    }
  }
  return { iflag: data[0] || 0, oflag: data[1] || 0, cflag: data[2] || 0, lflag: data[3] || 0, cc }
}

export type TtyHostOptions = {
  columns?: number
  rows?: number
  onOutput?: (bytes: Uint8Array) => void
  // True when the guest has other work waiting, which makes a console poll
  // return at once instead of parking. See `handle`.
  hasPendingWork?: () => boolean
}

export class TtyHost {
  readonly buffer: SharedArrayBuffer
  private control: Int32Array
  private payload: Int32Array
  private input: number[] = []
  private termios: Termios = defaultTermios()
  private columns: number
  private rows: number
  private outputListeners = new Set<(bytes: Uint8Array) => void>()
  private pendingPoll: ReturnType<typeof setTimeout> | null = null
  private waiting = false
  private disposed = false
  private hasPendingWork: () => boolean

  constructor (options: TtyHostOptions = {}) {
    this.hasPendingWork = options.hasPendingWork ?? (() => false)
    this.buffer = new SharedArrayBuffer(TTY_BUFFER_BYTES)
    this.control = new Int32Array(this.buffer, 0, 1)
    this.payload = new Int32Array(this.buffer, 4)
    this.columns = options.columns ?? 80
    this.rows = options.rows ?? 24
    if (options.onOutput) this.outputListeners.add(options.onOutput)
  }

  onOutput (listener: (bytes: Uint8Array) => void): () => void {
    this.outputListeners.add(listener)
    return () => { this.outputListeners.delete(listener) }
  }

  resize (columns: number, rows: number): void {
    this.columns = Math.max(1, Math.floor(columns))
    this.rows = Math.max(1, Math.floor(rows))
  }

  write (data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    for (const byte of bytes) this.input.push(byte)
    this.releasePoll(true)
  }

  // Ends a parked console poll without any console input arriving.
  //
  // The guest polls stdin and its network socket in the same `poll_oneoff`, and
  // it waits on the console first. Left alone it would sleep out the whole
  // clock timeout before looking at the socket, which throttles the container's
  // network to one packet per poll. The runtime calls this the moment frames
  // are queued for the guest, so the call returns "no console input" and the
  // guest goes straight on to read them.
  interrupt (): void {
    this.releasePoll(this.input.length > 0)
  }

  dispose (): void {
    this.disposed = true
    this.releasePoll(false)
    this.outputListeners.clear()
  }

  private reply (): void {
    Atomics.store(this.control, 0, 1)
    Atomics.notify(this.control, 0)
  }

  private releasePoll (readable: boolean): void {
    if (!this.waiting) return
    this.waiting = false
    if (this.pendingPoll) {
      clearTimeout(this.pendingPoll)
      this.pendingPoll = null
    }
    this.payload[0] = readable ? 1 : 0
    this.reply()
  }

  handle (request: TtyRequest): void {
    switch (request.ttyRequestType) {
      case 'read': {
        const count = Math.min(request.length, this.input.length, this.payload.length - 1)
        this.payload[0] = count
        for (let index = 0; index < count; index++) this.payload[index + 1] = this.input[index]!
        this.input.splice(0, count)
        break
      }
      case 'write': {
        const bytes = Uint8Array.from(request.buf)
        for (const listener of this.outputListeners) listener(bytes)
        break
      }
      case 'poll': {
        if (this.input.length > 0 || this.disposed) {
          this.payload[0] = this.input.length > 0 ? 1 : 0
          break
        }
        // The guest polls its console and its network socket in one
        // `poll_oneoff` and waits on the console first. If frames are already
        // queued, parking here would sleep out the guest's whole clock timeout
        // before it ever looks at them, which is one poll interval of delay per
        // packet. Answering "no console input" immediately sends it straight to
        // the socket.
        if (this.hasPendingWork()) {
          this.payload[0] = 0
          break
        }
        const timeoutMs = request.timeout * 1000
        if (!(timeoutMs > 0)) {
          this.payload[0] = 0
          break
        }
        this.waiting = true
        this.pendingPoll = setTimeout(
          () => { this.releasePoll(this.input.length > 0) },
          Math.min(timeoutMs, 0x7fffffff),
        )
        return
      }
      case 'tcgets': {
        const data = encodeTermios(this.termios)
        for (let index = 0; index < data.length; index++) this.payload[index] = data[index]!
        break
      }
      case 'tcsets': {
        this.termios = decodeTermios(request.data)
        break
      }
      case 'tiocgwinsz': {
        this.payload[0] = this.rows
        this.payload[1] = this.columns
        break
      }
    }
    this.reply()
  }
}
