import { Ciovec, ERRNO_AGAIN, ERRNO_INVAL, Iovec, type Wasi } from '../wasi'
import type { Channel } from './channel'

export class FrameSocket {
  constructor (private channel: Channel) {}

  accept (): boolean {
    this.channel.request({ type: 'accept' })
    return this.channel.data[0] === 1
  }

  send (bytes: Uint8Array): boolean {
    const status = this.channel.request({ type: 'send', buf: bytes })
    return status >= 0
  }

  recv (length: number): Uint8Array | null {
    const status = this.channel.request({ type: 'recv', len: length })
    if (status < 0) return null
    return this.channel.payload()
  }

  // `timeout` is in seconds. Omitted means "poll once, do not park".
  waitForReadable (timeout?: number): boolean | null {
    const status = this.channel.request({ type: 'recv-is-readable', timeout })
    if (status < 0) return null
    return this.channel.data[0] === 1
  }
}

export const installSocketImports = (
  wasi: Wasi,
  socket: FrameSocket,
  listenfd: number,
  connfd: number,
): void => {
  let connfdUsed = false
  const imports = wasi.wasiImport as Record<string, (...args: never[]) => number>
  const memory = (): ArrayBuffer => wasi.inst.exports.memory.buffer

  const previousClose = imports.fd_close!
  imports.fd_close = ((fd: number) => {
    if (fd === connfd) {
      connfdUsed = false
      return 0
    }
    return previousClose.call(wasi.wasiImport, fd as never)
  }) as never

  const previousRead = imports.fd_read!
  imports.fd_read = ((fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number) => {
    if (fd === connfd) {
      return (imports.sock_recv as unknown as (
        fd: number, iovsPtr: number, iovsLen: number, riFlags: number, nreadPtr: number, roFlagsPtr: number,
      ) => number)(fd, iovsPtr, iovsLen, 0, nreadPtr, 0)
    }
    return previousRead.call(wasi.wasiImport, fd as never, iovsPtr as never, iovsLen as never, nreadPtr as never)
  }) as never

  const previousWrite = imports.fd_write!
  imports.fd_write = ((fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number) => {
    if (fd === connfd) {
      return (imports.sock_send as unknown as (
        fd: number, iovsPtr: number, iovsLen: number, siFlags: number, nwrittenPtr: number,
      ) => number)(fd, iovsPtr, iovsLen, 0, nwrittenPtr)
    }
    return previousWrite.call(wasi.wasiImport, fd as never, iovsPtr as never, iovsLen as never, nwrittenPtr as never)
  }) as never

  const previousFdstatGet = imports.fd_fdstat_get!
  imports.fd_fdstat_get = ((fd: number, fdstatPtr: number) => {
    if (fd === listenfd || (fd === connfd && connfdUsed)) {
      const view = new DataView(memory())
      view.setUint8(fdstatPtr, 6)       // filetype socket_stream
      view.setUint8(fdstatPtr + 1, 2)   // fdflags nonblock
      return 0
    }
    return previousFdstatGet.call(wasi.wasiImport, fd as never, fdstatPtr as never)
  }) as never

  const previousPrestatGet = imports.fd_prestat_get!
  imports.fd_prestat_get = ((fd: number, prestatPtr: number) => {
    if (fd === listenfd || fd === connfd) {
      new DataView(memory()).setUint8(prestatPtr, 1)
      return 0
    }
    return previousPrestatGet.call(wasi.wasiImport, fd as never, prestatPtr as never)
  }) as never

  imports.sock_accept = ((fd: number, _flags: number, fdPtr: number) => {
    if (fd !== listenfd) return ERRNO_INVAL
    if (connfdUsed) return ERRNO_INVAL
    if (!socket.accept()) return ERRNO_AGAIN
    connfdUsed = true
    new DataView(memory()).setUint32(fdPtr, connfd, true)
    return 0
  }) as never

  imports.sock_send = ((
    fd: number, iovsPtr: number, iovsLen: number, _siFlags: number, nwrittenPtr: number,
  ) => {
    if (fd !== connfd) return ERRNO_INVAL
    const view = new DataView(memory())
    const bytes = new Uint8Array(memory())
    const iovecs = Ciovec.read_bytes_array(view, iovsPtr, iovsLen)
    let written = 0
    for (const iovec of iovecs) {
      if (iovec.buf_len === 0) continue
      const chunk = bytes.slice(iovec.buf, iovec.buf + iovec.buf_len)
      if (!socket.send(chunk)) return ERRNO_INVAL
      written += chunk.length
    }
    view.setUint32(nwrittenPtr, written, true)
    return 0
  }) as never

  imports.sock_recv = ((
    fd: number, iovsPtr: number, iovsLen: number, _riFlags: number, nreadPtr: number, _roFlagsPtr: number,
  ) => {
    if (fd !== connfd) return ERRNO_INVAL
    const readable = socket.waitForReadable()
    if (readable === null) return ERRNO_INVAL
    if (!readable) return ERRNO_AGAIN
    const view = new DataView(memory())
    const bytes = new Uint8Array(memory())
    const iovecs = Iovec.read_bytes_array(view, iovsPtr, iovsLen)
    let read = 0
    for (const iovec of iovecs) {
      if (iovec.buf_len === 0) continue
      const chunk = socket.recv(iovec.buf_len)
      if (chunk === null) return ERRNO_INVAL
      bytes.set(chunk, iovec.buf)
      read += chunk.length
    }
    view.setUint32(nreadPtr, read, true)
    return 0
  }) as never

  imports.sock_shutdown = ((fd: number) => {
    if (fd === connfd) connfdUsed = false
    return 0
  }) as never
}
