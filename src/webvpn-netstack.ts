// MAIN THREAD side of the c2w-webvpn netstack - runs alongside stack.ts.
//
// Owns the real egress sockets. When the proxy worker asks to connect/send/recv
// over a flow, those requests arrive here as postMessages and are serviced
// against FKN TCP and UDP sockets, with per-socket
// ring buffers filled asynchronously by @webvpn callbacks between the worker's
// synchronous round-trips.
//
// The buffer discipline (copy every received chunk before stashing it, drain
// into the SAB on demand) is ported from libtorrent's library_fkn.js, where
// reusing @webvpn's backing buffers across reads caused silent corruption.

import * as webvpnDgram from '@fkn/lib/dgram'
import { connect as webvpnConnect, createServer as webvpnCreateServer } from '@fkn/lib/net'

type AnyTcpSocket = ReturnType<typeof webvpnConnect>
type AnyUdpSocket = ReturnType<typeof webvpnDgram.createSocket>

type TcpState = {
  kind: 'tcp'
  sock: AnyTcpSocket
  chunks: Uint8Array[]
  total: number
  paused: boolean
  highWater: number
  ingress: boolean
  writeBlocked: boolean
  fin: boolean
  error: number
}

type UdpState = {
  kind: 'udp'
  sock: AnyUdpSocket
  host: string
  port: number
  datagrams: Uint8Array[]
  error: number
}

type SocketState = TcpState | UdpState

type SAB = {
  streamStatus: Int32Array
  streamLen: Int32Array
  streamData: Uint8Array
}

type NetstackRequest =
  | { type: 'webvpn_connect'; host: Uint8Array; port: number; network: number }
  | { type: 'webvpn_send'; id: number; buf: Uint8Array }
  | { type: 'webvpn_recv'; id: number; len: number }
  | { type: 'webvpn_end'; id: number }
  | { type: 'webvpn_close'; id: number }
  | { type: 'webvpn_image_size'; ref: Uint8Array }
  | { type: 'webvpn_image_chunk'; ref: Uint8Array; offset: number; len: number }
  | { type: 'webvpn_dns_query'; query: Uint8Array }
  | { type: 'webvpn_ingress_poll' }

export type ImageCacheEntry = {
  promise: Promise<Uint8Array> | null
  bytes: Uint8Array | null
}

export type Netstack = {
  // Returns either `true` synchronously (handled), or a Promise<void> for
  // async handlers, or `false` to delegate. Caller is responsible for the
  // Atomics notify after the (possibly-async) write completes.
  handle: (req: NetstackRequest, sab: SAB) => boolean | Promise<void>
  publishTCP: (guestPort: number) => Promise<PublishedTCPPort>
  close: () => Promise<void>
}

export type PublishedTCPPort = {
  guestPort: number
  relayPort: number
  close: () => Promise<void>
}

// Image cache - populated by main.ts when a Dockerfile hash is present in the URL.
// Worker requests image_size/chunk; we serve from cached bytes.
export type ImageCache = Map<string, ImageCacheEntry>

const TCP_BUFFER_HIGH_WATER = 4 * 1_024 * 1_024
const TCP_INGRESS_HIGH_WATER = 256 * 1_024
const MAX_INGRESS_CONNECTIONS = 32

type TCPPublication = { close: () => Promise<void> }

export const createWebvpnNetstack = (host: {
  imageCache: ImageCache
}): Netstack => {
  const sockets = new Map<number, SocketState>()
  const ingress: Array<{ id: number; guestPort: number }> = []
  const ingressSocketIds = new Set<number>()
  const publications = new Set<TCPPublication>()
  let closed = false
  let closePromise: Promise<void> | null = null
  let nextId = 1

  const nextSocketId = (): number => {
    const start = nextId
    do {
      const id = nextId
      nextId = nextId >= 0x7FFFFFFF ? 1 : nextId + 1
      if (!sockets.has(id)) return id
    } while (nextId !== start)
    throw new Error('webvpn socket id space exhausted')
  }

  const registerTCP = (
    sock: AnyTcpSocket,
    label: string,
    options: { ingress?: boolean; startPaused?: boolean } = {},
  ): number => {
    const id = nextSocketId()
    const isIngress = options.ingress === true
    const st: TcpState = {
      kind: 'tcp',
      sock,
      chunks: [],
      total: 0,
      paused: options.startPaused === true,
      highWater: isIngress ? TCP_INGRESS_HIGH_WATER : TCP_BUFFER_HIGH_WATER,
      ingress: isIngress,
      writeBlocked: false,
      fin: false,
      error: 0,
    }
    sockets.set(id, st)
    if (isIngress) ingressSocketIds.add(id)
    if (st.paused) sock.pause()
    sock.on('data', (chunk: Uint8Array | ArrayBuffer) => {
      const src = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
      const copy = new Uint8Array(src.length)
      copy.set(src)
      st.chunks.push(copy)
      st.total += copy.length
      if (!st.paused && st.total >= st.highWater) {
        st.paused = true
        sock.pause()
      }
    })
    sock.on('connect', () => {
      console.log('[webvpn] connected tcp ' + label + ' id=' + id)
    })
    sock.on('drain', () => { st.writeBlocked = false })
    sock.on('end', () => { st.fin = true })
    sock.on('close', () => { st.fin = true })
    sock.on('error', (error) => {
      console.log('[webvpn] tcp ' + label + ' id=' + id + ' failed: ' + error)
      st.error = 1
      st.fin = true
    })
    return id
  }

  const openTCP = (hostname: string, port: number): number =>
    registerTCP(webvpnConnect({ host: hostname, port }), hostname + ':' + port)

  const openUDP = (hostname: string, port: number): number => {
    const id = nextSocketId()
    const sock = webvpnDgram.createSocket({ type: 'udp4' })
    const st: UdpState = { kind: 'udp', sock, host: hostname, port, datagrams: [], error: 0 }
    sock.on('message', (data: Uint8Array | ArrayBuffer | { buffer: ArrayBuffer }) => {
      const src = data instanceof Uint8Array
        ? data
        : new Uint8Array((data as { buffer?: ArrayBuffer }).buffer || (data as ArrayBuffer))
      const copy = new Uint8Array(src.length)
      copy.set(src)
      st.datagrams.push(copy)
    })
    sock.on('error', () => { st.error = 1 })
    sockets.set(id, st)
    return id
  }

  const drainTCP = (st: TcpState, len: number): { bytes: Uint8Array; eof: boolean } => {
    if (st.total === 0) return { bytes: new Uint8Array(0), eof: st.fin || st.error !== 0 }
    const need = Math.min(len, st.total)
    const out = new Uint8Array(need)
    let off = 0
    while (off < need && st.chunks.length) {
      const chunk = st.chunks[0]!
      const take = Math.min(chunk.length, need - off)
      out.set(chunk.subarray(0, take), off)
      if (take === chunk.length) st.chunks.shift()
      else st.chunks[0] = chunk.subarray(take)
      st.total -= take
      off += take
    }
    if (st.paused && st.total <= st.highWater / 2) {
      st.paused = false
      st.sock.resume()
    }
    return { bytes: out, eof: false }
  }

  const drainUDP = (st: UdpState, len: number): { bytes: Uint8Array; eof: boolean } => {
    if (!st.datagrams.length) return { bytes: new Uint8Array(0), eof: false }
    const dg = st.datagrams.shift()!
    return { bytes: dg.subarray(0, Math.min(dg.length, len)), eof: false }
  }

  const closeSocket = (id: number): void => {
    const st = sockets.get(id)
    if (!st) return
    try {
      if (st.kind === 'tcp') (st.sock as { destroy: () => void }).destroy()
      else (st.sock as { close: () => void }).close()
    } catch (_e) { /* already gone */ }
    sockets.delete(id)
    ingressSocketIds.delete(id)
  }

  const publishTCP = (guestPort: number): Promise<PublishedTCPPort> => {
    if (closed) return Promise.reject(new Error('webvpn netstack is closed'))
    if (!Number.isInteger(guestPort) || guestPort < 1 || guestPort > 65535) {
      return Promise.reject(new Error('guest TCP port must be between 1 and 65535'))
    }

    return new Promise((resolve, reject) => {
      let bindState: 'pending' | 'bound' | 'failed' = 'pending'
      let publishSettled = false
      let closing = false
      let closePromise: Promise<void> | null = null
      let resolveBound!: () => void
      let rejectBound!: (error: unknown) => void
      const bound = new Promise<void>((resolveBind, rejectBind) => {
        resolveBound = resolveBind
        rejectBound = rejectBind
      })
      void bound.catch(() => {})
      const server = webvpnCreateServer((sock) => {
        if (closed || closing || ingressSocketIds.size >= MAX_INGRESS_CONNECTIONS) {
          sock.destroy()
          return
        }
        try {
          const id = registerTCP(sock, 'ingress for guest :' + guestPort, {
            ingress: true,
            startPaused: true,
          })
          ingress.push({ id, guestPort })
        } catch (_error) {
          sock.destroy()
        }
      })
      const publication: TCPPublication = {
        close: () => {
          if (closePromise) return closePromise
          closing = true
          closePromise = bound
            .then(() => new Promise<void>((resolveClose, rejectClose) => {
              server.close((error) => {
                if (error) rejectClose(error)
                else resolveClose()
              })
            }))
            .catch((error) => {
              if (bindState !== 'failed') throw error
            })
            .finally(() => publications.delete(publication))
          return closePromise
        },
      }
      publications.add(publication)
      server.on('error', (error) => {
        if (bindState === 'pending') {
          bindState = 'failed'
          rejectBound(error)
          publications.delete(publication)
          if (!publishSettled) {
            publishSettled = true
            reject(error)
          }
          return
        }
        console.log('[webvpn] tcp publication failed: ' + error)
      })
      server.listen(0, () => {
        if (bindState !== 'pending') return
        const address = server.address()
        if (!address || typeof address === 'string' || !address.port) {
          const error = new Error('FKN did not return a TCP relay port')
          bindState = 'failed'
          rejectBound(error)
          publications.delete(publication)
          server.close()
          if (!publishSettled) {
            publishSettled = true
            reject(error)
          }
          return
        }
        bindState = 'bound'
        resolveBound()
        if (closing) {
          if (!publishSettled) {
            publishSettled = true
            reject(new Error('TCP publication closed before it became ready'))
          }
          return
        }
        publishSettled = true
        resolve({ guestPort, relayPort: address.port, close: publication.close })
      })
    })
  }

  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    closed = true
    closePromise = (async () => {
      const results = await Promise.allSettled(
        Array.from(publications, (publication) => publication.close()),
      )
      for (const id of sockets.keys()) closeSocket(id)
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    })()
    return closePromise
  }

  return {
    handle (req, sab) {
      const { streamStatus, streamLen, streamData } = sab
      switch (req.type) {
        case 'webvpn_connect': {
          if (closed) { streamStatus[0] = -1; return true }
          const hostname = new TextDecoder().decode(req.host)
          const proto = req.network === 1 ? 'udp' : 'tcp'
          try {
            streamStatus[0] = req.network === 1
              ? openUDP(hostname, req.port)
              : openTCP(hostname, req.port)
            console.log('[webvpn] connect ' + proto + ' ' + hostname + ':' + req.port + ' -> id=' + streamStatus[0])
          } catch (error) {
            console.log('[webvpn] connect ' + proto + ' ' + hostname + ':' + req.port + ' FAILED: ' + error)
            streamStatus[0] = -1
          }
          return true
        }
        case 'webvpn_send': {
          const st = sockets.get(req.id)
          if (!st) { streamStatus[0] = -1; return true }
          if (st.error) { streamStatus[0] = -1; return true }
          if (st.kind === 'tcp' && st.writeBlocked) {
            streamStatus[0] = 0
            return true
          }
          try {
            if (st.kind === 'tcp') {
              st.writeBlocked = !st.sock.write(req.buf, (error) => {
                if (error) {
                  console.log('[webvpn] tcp id=' + req.id + ' write failed: ' + error)
                  st.error = 1
                  st.fin = true
                }
              })
            } else {
              st.sock.send(req.buf, 0, req.buf.length, st.port, st.host, (error) => {
                if (error) st.error = 1
              })
            }
            streamStatus[0] = req.buf.length
          } catch (_error) {
            streamStatus[0] = -1
          }
          return true
        }
        case 'webvpn_recv': {
          const st = sockets.get(req.id)
          if (!st) { streamStatus[0] = -1; return true }
          streamLen[0] = 0
          if (st.error && (st.kind === 'udp' || st.total === 0)) {
            streamStatus[0] = -1
            return true
          }
          const len = Math.min(req.len, streamData.byteLength)
          const out = st.kind === 'tcp' ? drainTCP(st, len) : drainUDP(st, len)
          streamLen[0] = out.bytes.length
          if (out.bytes.length > 0) streamData.set(out.bytes, 0)
          streamStatus[0] = out.eof ? 1 : 0
          return true
        }
        case 'webvpn_end': {
          const st = sockets.get(req.id)
          if (!st || st.kind !== 'tcp') { streamStatus[0] = -1; return true }
          const connection = st.sock._webVPNTcpSocketPromise
          if (!connection) { streamStatus[0] = -1; return true }
          return new Promise<void>((resolveEnd) => {
            try {
              st.sock.end(() => {
                connection.then(async (socket) => {
                  if (!socket) throw new Error('TCP socket is unavailable')
                  await socket.end()
                  streamStatus[0] = 0
                }).catch(() => {
                  streamStatus[0] = -1
                }).finally(resolveEnd)
              })
            } catch (_error) {
              streamStatus[0] = -1
              resolveEnd()
            }
          })
        }
        case 'webvpn_close': {
          closeSocket(req.id)
          streamStatus[0] = 0
          return true
        }
        case 'webvpn_ingress_poll': {
          let event = ingress.shift()
          while (event && !sockets.has(event.id)) event = ingress.shift()
          if (event) {
            const st = sockets.get(event.id)
            if (st?.kind === 'tcp' && st.ingress && st.paused) {
              st.paused = false
              st.sock.resume()
            }
          }
          streamStatus[0] = event?.id || 0
          streamLen[0] = event?.guestPort || 0
          streamData[0] = 0
          return true
        }
        case 'webvpn_image_size': {
          // Look up a pulled image's byte length. Cache populated by main.ts at
          // page load (one entry per FROM ref); the promise may still be pending.
          const ref = new TextDecoder().decode(req.ref)
          const entry = host.imageCache.get(ref)
          if (!entry) {
            console.log('[webvpn] image_size: not in cache: ' + ref)
            streamStatus[0] = -1
            return true
          }
          return Promise.resolve(entry.promise || entry.bytes).then((bytes) => {
            if (!bytes) throw new Error('image_size: null bytes')
            entry.bytes = bytes
            streamStatus[0] = bytes.length
            console.log('[webvpn] image_size ' + ref + ' -> ' + bytes.length + ' bytes')
          }).catch((e) => {
            console.log('[webvpn] image_size failed: ' + e)
            streamStatus[0] = -1
          })
        }
        case 'webvpn_image_chunk': {
          const ref = new TextDecoder().decode(req.ref)
          const entry = host.imageCache.get(ref)
          if (!entry || !entry.bytes) { streamStatus[0] = -1; return true }
          const start = Math.max(0, req.offset | 0)
          const end = Math.min(start + (req.len | 0), entry.bytes.length)
          const slice = entry.bytes.subarray(start, end)
          if (slice.length > 0) streamData.set(slice, 0)
          streamLen[0] = slice.length
          streamStatus[0] = 0
          return true
        }
        case 'webvpn_dns_query': {
          // Raw DNS wire-format → DoH (RFC 8484). cloudflare-dns.com sends CORS
          // headers so plain fetch works, skipping the slow per-query UDP path.
          return fetch('https://cloudflare-dns.com/dns-query', {
            method: 'POST',
            signal: AbortSignal.timeout(10_000),
            headers: {
              'Content-Type': 'application/dns-message',
              Accept: 'application/dns-message',
            },
            body: req.query as BodyInit,
          }).then(async (r) => {
            if (!r.ok) throw new Error('DoH returned ' + r.status)
            const bytes = new Uint8Array(await r.arrayBuffer())
            const n = Math.min(bytes.length, streamData.byteLength)
            streamData.set(bytes.subarray(0, n), 0)
            streamLen[0] = n
            streamStatus[0] = 0
          }).catch((e) => {
            console.log('[webvpn] dns_query failed: ' + e)
            streamStatus[0] = -1
          })
        }
        default:
          return false
      }
    },
    publishTCP,
    close,
  }
}
