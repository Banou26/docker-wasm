// Runs the gVisor network stack (c2w-webvpn-proxy.wasm).
//
// It terminates the guest's IP traffic and hands each TCP or UDP flow to the
// main thread, which dials it over FKN. The `env` imports below are the seam:
// every one is a blocking round-trip whose Go-side declaration lives in
// src/proxy/webvpn.go. Keep the two in sync.

import { Ciovec, ERRNO_INVAL, WASI, type Wasi } from '../wasi'
import type { NetstackWorkerInit } from '../protocol'
import { Channel } from './channel'
import { instantiate } from './load-wasm'
import { post } from './post'
import { readSubscriptions, writeEvents, type PollEvent } from './wasi-events'
import { FrameSocket, installSocketImports } from './wasi-socket'

const LISTEN_FD = 4
const CONN_FD = 5

const installConsoleImports = (wasi: Wasi, socket: FrameSocket, onLine: (line: string) => void): void => {
  const imports = wasi.wasiImport as Record<string, (...args: never[]) => number>
  imports.fd_fdstat_set_flags = (() => 0) as never

  const previousWrite = imports.fd_write!
  imports.fd_write = ((fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number) => {
    if (fd !== 1 && fd !== 2) {
      return previousWrite.call(wasi.wasiImport, fd as never, iovsPtr as never, iovsLen as never, nwrittenPtr as never)
    }
    const buffer = wasi.inst.exports.memory.buffer
    const view = new DataView(buffer)
    const bytes = new Uint8Array(buffer)
    let written = 0
    for (const iovec of Ciovec.read_bytes_array(view, iovsPtr, iovsLen)) {
      if (iovec.buf_len === 0) continue
      onLine(new TextDecoder().decode(bytes.subarray(iovec.buf, iovec.buf + iovec.buf_len)))
      written += iovec.buf_len
    }
    view.setUint32(nwrittenPtr, written, true)
    return 0
  }) as never

  imports.poll_oneoff = ((inPtr: number, outPtr: number, count: number, neventsPtr: number) => {
    if (count === 0) return ERRNO_INVAL
    const view = new DataView(wasi.inst.exports.memory.buffer)
    const subscriptions = readSubscriptions(view, inPtr, count)
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
      if (sub.fd !== CONN_FD) return ERRNO_INVAL
      connSub = sub
    }
    const events: PollEvent[] = []
    if (connSub || clockSub) {
      const readable = socket.waitForReadable(timeout / 1_000_000_000)
      if (connSub && readable === true) events.push({ userdata: connSub.userdata, variant: 'fd_read' })
      if (clockSub) events.push({ userdata: clockSub.userdata, variant: 'clock' })
    }
    writeEvents(view, outPtr, events)
    view.setUint32(neventsPtr, events.length, true)
    return 0
  }) as never
}

const egressImports =(wasi: Wasi, channel: Channel): WebAssembly.ModuleImports => {
  const memory = (): ArrayBuffer => wasi.inst.exports.memory.buffer
  const copyIn = (ptr: number, length: number): Uint8Array =>
    new Uint8Array(memory(), ptr, length).slice()

  return {
    // Reports the next FKN connection waiting to be routed into the guest.
    // Writes id 0 when the queue is empty.
    webvpn_ingress_poll: (networkP: number, idP: number, guestPortP: number) => {
      const status = channel.request({ type: 'webvpn_ingress_poll' })
      if (status < 0) return ERRNO_INVAL
      const view = new DataView(memory())
      view.setUint32(networkP, channel.data[0]!, true)
      view.setUint32(idP, status, true)
      view.setUint32(guestPortP, channel.length, true)
      return 0
    },

    // network: 0 = TCP, 1 = UDP.
    webvpn_connect: (network: number, hostP: number, hostLen: number, port: number, idP: number) => {
      const status = channel.request({
        type: 'webvpn_connect', network, host: copyIn(hostP, hostLen), port,
      })
      if (status < 0) return ERRNO_INVAL
      new DataView(memory()).setUint32(idP, status, true)
      return 0
    },

    // Writes the number of bytes accepted; 0 means backpressure.
    webvpn_send: (id: number, bufP: number, bufLen: number, nwrittenP: number) => {
      const status = channel.request({ type: 'webvpn_send', id, buf: copyIn(bufP, bufLen) })
      if (status < 0) return ERRNO_INVAL
      new DataView(memory()).setUint32(nwrittenP, status, true)
      return 0
    },

    // Writes bytes read (0 means would-block) and flags (bit 0 = EOF).
    webvpn_recv: (id: number, bufP: number, bufLen: number, nreadP: number, flagsP: number) => {
      const length = Math.min(bufLen, channel.data.byteLength)
      const status = channel.request({ type: 'webvpn_recv', id, len: length })
      if (status < 0) return ERRNO_INVAL
      const read = channel.length
      if (read > 0) new Uint8Array(memory()).set(channel.data.subarray(0, read), bufP)
      const view = new DataView(memory())
      view.setUint32(nreadP, read, true)
      view.setUint32(flagsP, status === 1 ? 1 : 0, true)
      return 0
    },

    // Half-close: sends FIN, leaves the receive direction open.
    webvpn_end: (id: number) => channel.request({ type: 'webvpn_end', id }) < 0 ? ERRNO_INVAL : 0,

    webvpn_close: (id: number) => {
      channel.request({ type: 'webvpn_close', id })
      return 0
    },

    webvpn_dns_query: (queryP: number, queryLen: number, respP: number, respCap: number, respLenP: number) => {
      const status = channel.request({ type: 'webvpn_dns_query', query: copyIn(queryP, queryLen) })
      if (status < 0) return ERRNO_INVAL
      const length = Math.min(channel.length, respCap)
      if (length > 0) new Uint8Array(memory()).set(channel.data.subarray(0, length), respP)
      new DataView(memory()).setUint32(respLenP, length, true)
      return 0
    },

    // Local artifact bridge: the guest can wget files the page put in the
    // image cache. Used by the Dockerfile builder image, not by prebuilt ones.
    webvpn_image_size: (refP: number, refLen: number, sizeP: number) => {
      const status = channel.request({ type: 'webvpn_image_size', ref: copyIn(refP, refLen) })
      if (status < 0) return ERRNO_INVAL
      new DataView(memory()).setUint32(sizeP, status, true)
      return 0
    },

    webvpn_image_chunk: (
      refP: number, refLen: number, offset: number, bufP: number, bufCap: number, nReadP: number,
    ) => {
      const cap = Math.min(bufCap, channel.data.byteLength)
      const status = channel.request({
        type: 'webvpn_image_chunk', ref: copyIn(refP, refLen), offset, len: cap,
      })
      if (status < 0) return ERRNO_INVAL
      const read = channel.length
      if (read > 0) new Uint8Array(memory()).set(channel.data.subarray(0, read), bufP)
      new DataView(memory()).setUint32(nReadP, read, true)
      return 0
    },
  }
}

let started = false

self.onmessage = (event: MessageEvent) => {
  const message = event.data as NetstackWorkerInit
  if (message?.type !== 'init' || started) return
  started = true

  const channel = new Channel(message.stream)
  const socket = new FrameSocket(channel)

  const args = ['arg0', '--net-listenfd=' + LISTEN_FD]
  if (message.ingress) args.push('--ingress')

  const wasi = new WASI(args, [], [undefined, undefined, undefined, undefined, undefined, undefined])
  installConsoleImports(wasi, socket, (line) => console.debug('[netstack]', line.trimEnd()))
  installSocketImports(wasi, socket, LISTEN_FD, CONN_FD)

  instantiate(message.image, {
    wasi_snapshot_preview1: wasi.wasiImport as unknown as WebAssembly.ModuleImports,
    env: egressImports(wasi, channel),
  })
    .then((instance) => wasi.start(instance))
    .catch((error: unknown) => {
      post({ type: 'error', message: 'network stack failed: ' + String(error) })
    })
}
