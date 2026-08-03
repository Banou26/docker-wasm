// every received chunk is copied before it is queued: the transport reuses its backing buffers between reads

import './node-globals'
import * as dgram from '@fkn/lib/dgram'
import { connect as tcpConnect, createServer as tcpCreateServer } from '@fkn/lib/net'
import type { StreamView } from './protocol'

type TcpSocket = ReturnType<typeof tcpConnect>
type UdpSocket = ReturnType<typeof dgram.createSocket>

type TcpState = {
  kind: 'tcp'
  socket: TcpSocket
  chunks: Uint8Array[]
  pending: number
  paused: boolean
  highWater: number
  ingress: boolean
  writeBlocked: boolean
  finished: boolean
  failed: boolean
}

type UdpState = {
  kind: 'udp'
  socket: UdpSocket
  host: string
  port: number
  datagrams: Uint8Array[]
  failed: boolean
}

type SocketState = TcpState | UdpState

export type NetstackRequest =
  | { type: 'webvpn_connect'; host: Uint8Array; port: number; network: number }
  | { type: 'webvpn_send'; id: number; buf: Uint8Array }
  | { type: 'webvpn_recv'; id: number; len: number }
  | { type: 'webvpn_end'; id: number }
  | { type: 'webvpn_close'; id: number }
  | { type: 'webvpn_image_size'; ref: Uint8Array }
  | { type: 'webvpn_image_chunk'; ref: Uint8Array; offset: number; len: number }
  | { type: 'webvpn_dns_query'; query: Uint8Array }
  | { type: 'webvpn_ingress_poll' }

export type ArtifactCacheEntry = {
  promise: Promise<Uint8Array> | null
  bytes: Uint8Array | null
}

export type ArtifactCache = Map<string, ArtifactCacheEntry>

export type PublishedPort = {
  guestPort: number
  host: string
  port: number
  close: () => Promise<void>
}

export type Netstack = {
  handle: (request: NetstackRequest, view: StreamView) => boolean | Promise<void>
  listen: (guestPort: number) => Promise<PublishedPort>
  close: () => Promise<void>
}

const EGRESS_HIGH_WATER = 4 * 1024 * 1024
const INGRESS_HIGH_WATER = 256 * 1024
const MAX_INGRESS_CONNECTIONS = 64

export type NetstackOptions = {
  artifacts?: ArtifactCache
  // wire-format DNS resolver, defaulting to DNS over HTTPS, which answers in one round trip instead of the many the guest's resolver would make over UDP
  dnsResolver?: (query: Uint8Array) => Promise<Uint8Array>
  onLog?: (message: string) => void
}

const doh = async (query: Uint8Array): Promise<Uint8Array> => {
  const response = await fetch('https://cloudflare-dns.com/dns-query', {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: { 'Content-Type': 'application/dns-message', Accept: 'application/dns-message' },
    body: query as BodyInit,
  })
  if (!response.ok) throw new Error('DNS over HTTPS returned ' + response.status)
  return new Uint8Array(await response.arrayBuffer())
}

export const createNetstack = (options: NetstackOptions = {}): Netstack => {
  const artifacts = options.artifacts ?? new Map<string, ArtifactCacheEntry>()
  const resolve = options.dnsResolver ?? doh
  const log = options.onLog ?? (() => {})

  const sockets = new Map<number, SocketState>()
  const ingressQueue: Array<{ id: number; guestPort: number }> = []
  const ingressIds = new Set<number>()
  const listeners = new Set<{ close: () => Promise<void> }>()
  let closed = false
  let closing: Promise<void> | null = null
  let nextId = 1

  const allocateId = (): number => {
    const start = nextId
    do {
      const id = nextId
      nextId = nextId >= 0x7fffffff ? 1 : nextId + 1
      if (!sockets.has(id)) return id
    } while (nextId !== start)
    throw new Error('socket id space exhausted')
  }

  const registerTcp = (
    socket: TcpSocket,
    label: string,
    setup: { ingress?: boolean; startPaused?: boolean } = {},
  ): number => {
    const id = allocateId()
    const ingress = setup.ingress === true
    const state: TcpState = {
      kind: 'tcp',
      socket,
      chunks: [],
      pending: 0,
      paused: setup.startPaused === true,
      highWater: ingress ? INGRESS_HIGH_WATER : EGRESS_HIGH_WATER,
      ingress,
      writeBlocked: false,
      finished: false,
      failed: false,
    }
    sockets.set(id, state)
    if (ingress) ingressIds.add(id)
    if (state.paused) socket.pause()
    socket.on('data', (chunk: Uint8Array | ArrayBuffer) => {
      const source = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
      const copy = new Uint8Array(source.length)
      copy.set(source)
      state.chunks.push(copy)
      state.pending += copy.length
      if (!state.paused && state.pending >= state.highWater) {
        state.paused = true
        socket.pause()
      }
    })
    socket.on('drain', () => { state.writeBlocked = false })
    socket.on('end', () => { state.finished = true })
    socket.on('close', () => { state.finished = true })
    socket.on('error', (error) => {
      log('tcp ' + label + ' id=' + id + ' failed: ' + error)
      state.failed = true
      state.finished = true
    })
    return id
  }

  const openTcp = (host: string, port: number): number =>
    registerTcp(tcpConnect({ host, port }), host + ':' + port)

  const openUdp = (host: string, port: number): number => {
    const id = allocateId()
    const socket = dgram.createSocket({ type: 'udp4' })
    const state: UdpState = { kind: 'udp', socket, host, port, datagrams: [], failed: false }
    socket.on('message', (data: Uint8Array | ArrayBuffer | { buffer: ArrayBuffer }) => {
      const source = data instanceof Uint8Array
        ? data
        : new Uint8Array((data as { buffer?: ArrayBuffer }).buffer || (data as ArrayBuffer))
      const copy = new Uint8Array(source.length)
      copy.set(source)
      state.datagrams.push(copy)
    })
    socket.on('error', () => { state.failed = true })
    sockets.set(id, state)
    return id
  }

  const drainTcp = (state: TcpState, into: Uint8Array, limit: number): { count: number; eof: boolean } => {
    if (state.pending === 0) return { count: 0, eof: state.finished || state.failed }
    const want = Math.min(limit, state.pending)
    let written = 0
    while (written < want) {
      const chunk = state.chunks[0]!
      const take = Math.min(chunk.length, want - written)
      into.set(chunk.subarray(0, take), written)
      if (take === chunk.length) state.chunks.shift()
      else state.chunks[0] = chunk.subarray(take)
      state.pending -= take
      written += take
    }
    if (state.paused && state.pending <= state.highWater / 2) {
      state.paused = false
      state.socket.resume()
    }
    return { count: written, eof: false }
  }

  const drainUdp = (state: UdpState, into: Uint8Array, limit: number): { count: number; eof: boolean } => {
    const datagram = state.datagrams.shift()
    if (!datagram) return { count: 0, eof: false }
    const count = Math.min(datagram.length, limit)
    into.set(datagram.subarray(0, count), 0)
    return { count, eof: false }
  }

  const closeSocket = (id: number): void => {
    const state = sockets.get(id)
    if (!state) return
    try {
      if (state.kind === 'tcp') state.socket.destroy()
      else state.socket.close()
    } catch {}
    sockets.delete(id)
    ingressIds.delete(id)
  }

  const listen = (guestPort: number): Promise<PublishedPort> => {
    if (closed) return Promise.reject(new Error('container network is closed'))
    if (!Number.isInteger(guestPort) || guestPort < 1 || guestPort > 65535) {
      return Promise.reject(new Error('published port must be between 1 and 65535, got ' + guestPort))
    }

    return new Promise((resolvePort, rejectPort) => {
      let bindState: 'pending' | 'bound' | 'failed' = 'pending'
      let settled = false
      let stopping = false
      let stopPromise: Promise<void> | null = null
      let markBound!: () => void
      let markBindFailed!: (error: unknown) => void
      const bound = new Promise<void>((done, fail) => {
        markBound = done
        markBindFailed = fail
      })
      void bound.catch(() => {})

      const server = tcpCreateServer((socket) => {
        if (closed || stopping || ingressIds.size >= MAX_INGRESS_CONNECTIONS) {
          socket.destroy()
          return
        }
        try {
          // held paused until the netstack claims it, so nothing is buffered for a connection the guest has not accepted yet
          const id = registerTcp(socket, 'ingress :' + guestPort, { ingress: true, startPaused: true })
          ingressQueue.push({ id, guestPort })
        } catch {
          socket.destroy()
        }
      })

      const listener = {
        close: (): Promise<void> => {
          if (stopPromise) return stopPromise
          stopping = true
          stopPromise = bound
            .then(() => new Promise<void>((done, fail) => {
              server.close((error) => (error ? fail(error) : done()))
            }))
            .catch((error) => { if (bindState !== 'failed') throw error })
            .finally(() => { listeners.delete(listener) })
          return stopPromise
        },
      }
      listeners.add(listener)

      server.on('error', (error) => {
        if (bindState !== 'pending') {
          log('published port :' + guestPort + ' listener failed: ' + error)
          return
        }
        bindState = 'failed'
        markBindFailed(error)
        listeners.delete(listener)
        if (!settled) {
          settled = true
          rejectPort(error)
        }
      })

      server.listen(0, '127.0.0.1', () => {
        if (bindState !== 'pending') return
        const address = server.address()
        if (!address || typeof address === 'string' || !address.port) {
          const error = new Error('no virtual TCP port was assigned')
          bindState = 'failed'
          markBindFailed(error)
          listeners.delete(listener)
          server.close()
          if (!settled) {
            settled = true
            rejectPort(error)
          }
          return
        }
        bindState = 'bound'
        markBound()
        if (stopping) {
          if (!settled) {
            settled = true
            rejectPort(new Error('published port closed before it was ready'))
          }
          return
        }
        settled = true
        resolvePort({
          guestPort,
          host: address.address,
          port: address.port,
          close: listener.close,
        })
      })
    })
  }

  const close = (): Promise<void> => {
    if (closing) return closing
    closed = true
    closing = (async () => {
      const results = await Promise.allSettled(Array.from(listeners, (listener) => listener.close()))
      for (const id of Array.from(sockets.keys())) closeSocket(id)
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    })()
    return closing
  }

  const handle = (request: NetstackRequest, view: StreamView): boolean | Promise<void> => {
    const { status, length, data } = view
    switch (request.type) {
      case 'webvpn_connect': {
        if (closed) {
          status[0] = -1
          return true
        }
        const host = new TextDecoder().decode(request.host)
        try {
          status[0] = request.network === 1 ? openUdp(host, request.port) : openTcp(host, request.port)
        } catch (error) {
          log('connect ' + host + ':' + request.port + ' failed: ' + error)
          status[0] = -1
        }
        return true
      }

      case 'webvpn_send': {
        const state = sockets.get(request.id)
        if (!state || (state.kind === 'tcp' ? state.failed : state.failed)) {
          status[0] = -1
          return true
        }
        if (state.kind === 'tcp' && state.writeBlocked) {
          status[0] = 0   // 0 means backpressure: the netstack retries
          return true
        }
        try {
          if (state.kind === 'tcp') {
            state.writeBlocked = !state.socket.write(request.buf, (error) => {
              if (!error) return
              log('tcp id=' + request.id + ' write failed: ' + error)
              state.failed = true
              state.finished = true
            })
          } else {
            state.socket.send(request.buf, 0, request.buf.length, state.port, state.host, (error) => {
              if (error) state.failed = true
            })
          }
          status[0] = request.buf.length
        } catch {
          status[0] = -1
        }
        return true
      }

      case 'webvpn_recv': {
        const state = sockets.get(request.id)
        if (!state) {
          status[0] = -1
          return true
        }
        length[0] = 0
        if (state.failed && (state.kind === 'udp' || state.pending === 0)) {
          status[0] = -1
          return true
        }
        const limit = Math.min(request.len, data.byteLength)
        const result = state.kind === 'tcp'
          ? drainTcp(state, data, limit)
          : drainUdp(state, data, limit)
        length[0] = result.count
        status[0] = result.eof ? 1 : 0
        return true
      }

      case 'webvpn_end': {
        const state = sockets.get(request.id)
        if (!state || state.kind !== 'tcp') {
          status[0] = -1
          return true
        }
        const connection = state.socket._webVPNTcpSocketPromise
        if (!connection) {
          status[0] = -1
          return true
        }
        return new Promise<void>((done) => {
          try {
            state.socket.end(() => {
              connection
                .then(async (socket) => {
                  if (!socket) throw new Error('socket is unavailable')
                  await socket.end()
                  status[0] = 0
                })
                .catch(() => { status[0] = -1 })
                .finally(done)
            })
          } catch {
            status[0] = -1
            done()
          }
        })
      }

      case 'webvpn_close': {
        closeSocket(request.id)
        status[0] = 0
        return true
      }

      case 'webvpn_ingress_poll': {
        let event = ingressQueue.shift()
        while (event && !sockets.has(event.id)) event = ingressQueue.shift()
        if (event) {
          const state = sockets.get(event.id)
          if (state?.kind === 'tcp' && state.ingress && state.paused) {
            state.paused = false
            state.socket.resume()
          }
        }
        status[0] = event?.id || 0
        length[0] = event?.guestPort || 0
        data[0] = 0
        return true
      }

      case 'webvpn_image_size': {
        const ref = new TextDecoder().decode(request.ref)
        const entry = artifacts.get(ref)
        if (!entry) {
          log('artifact ' + ref + ' was requested but is not offered')
          status[0] = -1
          return true
        }
        return Promise.resolve(entry.promise || entry.bytes)
          .then((bytes) => {
            if (!bytes) throw new Error('artifact ' + ref + ' resolved to nothing')
            entry.bytes = bytes
            status[0] = bytes.length
            log('artifact ' + ref + ' is ' + bytes.length + ' bytes')
          })
          .catch((error: unknown) => {
            log('artifact ' + ref + ' unavailable: ' + String(error))
            status[0] = -1
          })
      }

      case 'webvpn_image_chunk': {
        const ref = new TextDecoder().decode(request.ref)
        const entry = artifacts.get(ref)
        if (!entry?.bytes) {
          status[0] = -1
          return true
        }
        const start = Math.max(0, request.offset | 0)
        const end = Math.min(start + (request.len | 0), entry.bytes.length)
        const slice = entry.bytes.subarray(start, end)
        if (slice.length > 0) data.set(slice, 0)
        length[0] = slice.length
        status[0] = 0
        if (start % (1024 * 1024) < slice.length) {
          log('artifact ' + ref + ' served ' + start + '/' + entry.bytes.length)
        }
        return true
      }

      case 'webvpn_dns_query': {
        return resolve(request.query)
          .then((answer) => {
            const count = Math.min(answer.length, data.byteLength)
            data.set(answer.subarray(0, count), 0)
            length[0] = count
            status[0] = 0
          })
          .catch((error: unknown) => {
            log('DNS query failed: ' + String(error))
            status[0] = -1
          })
      }

      default:
        return false
    }
  }

  return { handle, listen, close }
}
