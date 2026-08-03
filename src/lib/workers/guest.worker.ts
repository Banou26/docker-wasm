import { Ciovec, ERRNO_INVAL, Iovec, WASI, type Wasi } from '../wasi'
import type { GuestWorkerInit } from '../protocol'
import { Channel } from './channel'
import { instantiate } from './load-wasm'
import { post } from './post'
import { TtyClient } from './tty-client'
import { readSubscriptions, writeEvents, type PollEvent } from './wasi-events'
import { FrameSocket, installSocketImports } from './wasi-socket'

const LISTEN_FD = 4
const CONN_FD = 5

const randomMac = (): string => {
  const bytes = new Uint8Array(5)
  crypto.getRandomValues(bytes)
  return '02:' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(':')
}

const installConsoleImports = (wasi: Wasi, tty: TtyClient, socket: FrameSocket | null): void => {
  const imports = wasi.wasiImport as Record<string, (...args: never[]) => number>
  const memory = (): ArrayBuffer => wasi.inst.exports.memory.buffer

  const previousRead = imports.fd_read!
  imports.fd_read = ((fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number) => {
    if (fd !== 0) {
      return previousRead.call(wasi.wasiImport, fd as never, iovsPtr as never, iovsLen as never, nreadPtr as never)
    }
    const view = new DataView(memory())
    const bytes = new Uint8Array(memory())
    let read = 0
    for (const iovec of Iovec.read_bytes_array(view, iovsPtr, iovsLen)) {
      if (iovec.buf_len === 0) continue
      const chunk = tty.onRead(iovec.buf_len)
      bytes.set(chunk, iovec.buf)
      read += chunk.length
    }
    view.setUint32(nreadPtr, read, true)
    return 0
  }) as never

  const previousWrite = imports.fd_write!
  imports.fd_write = ((fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number) => {
    if (fd !== 1 && fd !== 2) {
      return previousWrite.call(wasi.wasiImport, fd as never, iovsPtr as never, iovsLen as never, nwrittenPtr as never)
    }
    const view = new DataView(memory())
    const bytes = new Uint8Array(memory())
    let written = 0
    for (const iovec of Ciovec.read_bytes_array(view, iovsPtr, iovsLen)) {
      if (iovec.buf_len === 0) continue
      tty.onWrite(Array.from(bytes.subarray(iovec.buf, iovec.buf + iovec.buf_len)))
      written += iovec.buf_len
    }
    view.setUint32(nwrittenPtr, written, true)
    return 0
  }) as never

  imports.poll_oneoff = ((inPtr: number, outPtr: number, count: number, neventsPtr: number) => {
    if (count === 0) return ERRNO_INVAL
    const view = new DataView(memory())
    const subscriptions = readSubscriptions(view, inPtr, count)

    let stdinSub: (typeof subscriptions)[number] | null = null
    let connSub: (typeof subscriptions)[number] | null = null
    let clockSub: (typeof subscriptions)[number] | null = null
    let timeout = Number.MAX_VALUE

    for (const sub of subscriptions) {
      if (sub.variant === 'clock') {
        if (sub.timeout < timeout) {
          timeout = sub.timeout
          clockSub = sub
        }
        continue
      }
      if (sub.fd === 0) stdinSub = sub
      else if (sub.fd === CONN_FD) connSub = sub
      else return ERRNO_INVAL
    }

    const events: PollEvent[] = []
    if (stdinSub || (clockSub && timeout > 0)) {
      if (tty.onWaitForReadable(timeout / 1_000_000_000) && stdinSub) {
        events.push({ userdata: stdinSub.userdata, variant: 'fd_read' })
      }
    }
    if (connSub && socket) {
      const readable = socket.waitForReadable()
      if (readable === null) return ERRNO_INVAL
      if (readable) events.push({ userdata: connSub.userdata, variant: 'fd_read' })
    }
    if (clockSub) events.push({ userdata: clockSub.userdata, variant: 'clock' })

    writeEvents(view, outPtr, events)
    view.setUint32(neventsPtr, events.length, true)
    return 0
  }) as never
}

let started = false

self.onmessage = (event: MessageEvent) => {
  const message = event.data as GuestWorkerInit
  if (message?.type !== 'init' || started) return
  started = true

  const tty = new TtyClient(message.tty)
  const channel = new Channel(message.stream)
  const socket = message.network ? new FrameSocket(channel) : null

  const args = message.network
    ? ['arg0', '--net=socket=listenfd=' + LISTEN_FD, '--mac', randomMac()]
    : ['arg0']
  const fds = message.network
    ? [undefined, undefined, undefined, undefined, undefined, undefined]
    : []

  const wasi = new WASI(args, [], fds)
  installConsoleImports(wasi, tty, socket)
  if (socket) installSocketImports(wasi, socket, LISTEN_FD, CONN_FD)

  const startedAt = performance.now()
  instantiate(message.image, { wasi_snapshot_preview1: wasi.wasiImport as unknown as WebAssembly.ModuleImports })
    .then((instance) => {
      post({ type: 'status', stage: 'started', elapsedMs: Math.round(performance.now() - startedAt) })
      wasi.start(instance)
      post({ type: 'status', stage: 'exited', elapsedMs: Math.round(performance.now() - startedAt) })
    })
    .catch((error: unknown) => {
      post({ type: 'error', message: 'container guest failed: ' + String(error) })
    })
}
