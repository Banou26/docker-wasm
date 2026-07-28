// HTTP/1.1 over the in-process TCP route into the container.
//
// The container is reachable through an FKN loopback listener, not through the
// browser's network stack, so `fetch` cannot address it. This is a small client
// that speaks HTTP/1.1 on those sockets and hands back a real `Response`, body
// streamed rather than buffered.
//
// Connections are pooled and reused. A server that closes an idle keep-alive
// connection races every client that tries to reuse it, so a request that dies
// before a single response byte arrives is retried once on a fresh socket. That
// retry is what makes repeated calls to a one-connection-at-a-time server, the
// shape most small container services have, behave predictably.

import './node-globals'
import { connect } from '@fkn/lib/net'

type Socket = ReturnType<typeof connect>

const CRLF = '\r\n'
const HEAD_TERMINATOR = new Uint8Array([13, 10, 13, 10])

export type HttpEndpoint = { host: string; port: number }

export class HttpError extends Error {
  constructor (message: string, override readonly cause?: unknown) {
    super(message)
    this.name = 'HttpError'
  }
}

const indexOfSequence = (haystack: Uint8Array, needle: Uint8Array, from: number): number => {
  outer: for (let index = Math.max(0, from); index <= haystack.length - needle.length; index++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[index + offset] !== needle[offset]) continue outer
    }
    return index
  }
  return -1
}

// A socket with an awaitable read queue. The transport is event based; the
// parser below wants to pull.
class Connection {
  private chunks: Uint8Array[] = []
  private pending = 0
  private waiter: (() => void) | null = null
  private closed = false
  failure: Error | null = null
  ended = false
  broken = false
  bytesRead = 0

  private constructor (readonly socket: Socket, readonly endpoint: HttpEndpoint) {
    socket.on('data', (chunk: Uint8Array | ArrayBuffer) => {
      const source = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
      const copy = new Uint8Array(source.length)
      copy.set(source)
      this.chunks.push(copy)
      this.pending += copy.length
      this.bytesRead += copy.length
      this.wake()
    })
    socket.on('end', () => { this.ended = true; this.wake() })
    socket.on('close', () => { this.ended = true; this.closed = true; this.wake() })
    socket.on('error', (error: unknown) => {
      this.failure = error instanceof Error ? error : new Error(String(error))
      this.ended = true
      this.wake()
    })
  }

  static open (endpoint: HttpEndpoint, timeoutMs: number, signal?: AbortSignal): Promise<Connection> {
    return new Promise((resolve, reject) => {
      let socket: Socket
      try {
        socket = connect({ host: endpoint.host, port: endpoint.port })
      } catch (error) {
        reject(new HttpError('could not open a route to the container', error))
        return
      }
      const connection = new Connection(socket, endpoint)
      let settled = false
      const finish = (run: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        run()
      }
      const onAbort = (): void => finish(() => {
        connection.destroy()
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      })
      const timer = setTimeout(() => finish(() => {
        connection.destroy()
        reject(new HttpError('timed out connecting to the container after ' + timeoutMs + ' ms'))
      }), timeoutMs)

      socket.on('connect', () => finish(() => resolve(connection)))
      socket.on('error', (error: unknown) => finish(() => {
        connection.destroy()
        reject(new HttpError('could not reach the container', error))
      }))
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private wake (): void {
    const waiter = this.waiter
    this.waiter = null
    waiter?.()
  }

  get buffered (): number { return this.pending }

  // Resolves with the next available bytes, or null once the peer is done.
  async read (timeoutMs: number, signal?: AbortSignal): Promise<Uint8Array | null> {
    while (this.pending === 0) {
      if (this.failure) throw new HttpError('the container connection failed', this.failure)
      if (this.ended) return null
      signal?.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup()
          reject(new HttpError('the container did not respond within ' + timeoutMs + ' ms'))
        }, timeoutMs)
        const onAbort = (): void => {
          cleanup()
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        }
        const cleanup = (): void => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          if (this.waiter === resolveOnce) this.waiter = null
        }
        const resolveOnce = (): void => {
          cleanup()
          resolve()
        }
        this.waiter = resolveOnce
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
    const chunk = this.chunks.shift()!
    this.pending -= chunk.length
    return chunk
  }

  unread (chunk: Uint8Array): void {
    if (chunk.length === 0) return
    this.chunks.unshift(chunk)
    this.pending += chunk.length
  }

  write (bytes: Uint8Array): void {
    this.socket.write(bytes)
  }

  get reusable (): boolean {
    return !this.closed && !this.ended && !this.failure && !this.broken
  }

  destroy (): void {
    this.broken = true
    try { this.socket.destroy() } catch { /* already gone */ }
  }
}

class Pool {
  private idle = new Map<string, Connection[]>()

  private static key (endpoint: HttpEndpoint): string {
    return endpoint.host + ':' + endpoint.port
  }

  take (endpoint: HttpEndpoint): Connection | null {
    const bucket = this.idle.get(Pool.key(endpoint))
    while (bucket && bucket.length > 0) {
      const connection = bucket.pop()!
      if (connection.reusable) return connection
      connection.destroy()
    }
    return null
  }

  give (connection: Connection): void {
    if (!connection.reusable) {
      connection.destroy()
      return
    }
    const key = Pool.key(connection.endpoint)
    const bucket = this.idle.get(key) ?? []
    // One idle socket per endpoint. Small container services usually accept a
    // single connection at a time, so hoarding sockets only stalls the guest.
    if (bucket.length >= 1) {
      connection.destroy()
      return
    }
    bucket.push(connection)
    this.idle.set(key, bucket)
  }

  clear (): void {
    for (const bucket of this.idle.values()) {
      for (const connection of bucket) connection.destroy()
    }
    this.idle.clear()
  }
}

type ParsedHead = {
  status: number
  statusText: string
  httpVersion: string
  headers: Headers
  rest: Uint8Array
}

const parseHead = (head: string, rest: Uint8Array): ParsedHead => {
  const lines = head.split(CRLF)
  const statusLine = lines[0] || ''
  const match = /^HTTP\/(\d+\.\d+)\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine)
  if (!match) throw new HttpError('the container sent a malformed status line: ' + JSON.stringify(statusLine))
  const headers = new Headers()
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]!
    if (!line) continue
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const name = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    try { headers.append(name, value) } catch { /* header names the platform rejects */ }
  }
  return {
    httpVersion: match[1]!,
    status: Number(match[2]),
    statusText: match[3] || '',
    headers,
    rest,
  }
}

const readHead = async (
  connection: Connection,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ParsedHead> => {
  let buffer = new Uint8Array(0)
  let searchFrom = 0
  while (true) {
    const boundary = indexOfSequence(buffer, HEAD_TERMINATOR, searchFrom)
    if (boundary >= 0) {
      const head = new TextDecoder().decode(buffer.subarray(0, boundary))
      return parseHead(head, buffer.subarray(boundary + 4))
    }
    searchFrom = Math.max(0, buffer.length - 3)
    const chunk = await connection.read(timeoutMs, signal)
    if (chunk === null) {
      if (buffer.length === 0) throw new HttpError('the container closed the connection before responding')
      throw new HttpError('the container closed the connection mid-header')
    }
    const grown = new Uint8Array(buffer.length + chunk.length)
    grown.set(buffer, 0)
    grown.set(chunk, buffer.length)
    buffer = grown
    if (buffer.length > 256 * 1024) throw new HttpError('the container sent oversized response headers')
  }
}

type BodyFraming =
  | { kind: 'none' }
  | { kind: 'length'; length: number }
  | { kind: 'chunked' }
  | { kind: 'until-close' }

const framingFor = (method: string, head: ParsedHead): BodyFraming => {
  const status = head.status
  if (method === 'HEAD' || status === 204 || status === 304 || (status >= 100 && status < 200)) {
    return { kind: 'none' }
  }
  const encoding = (head.headers.get('transfer-encoding') || '').toLowerCase()
  if (encoding.split(',').some((token) => token.trim() === 'chunked')) return { kind: 'chunked' }
  const contentLength = head.headers.get('content-length')
  if (contentLength !== null) {
    const length = Number(contentLength)
    if (Number.isFinite(length) && length >= 0) return { kind: 'length', length }
  }
  return { kind: 'until-close' }
}

const bodyStream = (
  connection: Connection,
  framing: BodyFraming,
  head: ParsedHead,
  timeoutMs: number,
  onDone: (reusable: boolean) => void,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> | null => {
  if (framing.kind === 'none') {
    if (head.rest.length > 0) connection.unread(head.rest)
    onDone(true)
    return null
  }

  let leftover: Uint8Array | null = head.rest.length > 0 ? head.rest : null
  const pull = async (): Promise<Uint8Array | null> => {
    if (leftover) {
      const chunk = leftover
      leftover = null
      return chunk
    }
    return connection.read(timeoutMs, signal)
  }

  if (framing.kind === 'length') {
    let remaining = framing.length
    return new ReadableStream<Uint8Array>({
      async pull (controller) {
        if (remaining === 0) {
          controller.close()
          onDone(true)
          return
        }
        const chunk = await pull()
        if (chunk === null) {
          controller.error(new HttpError('the container closed the connection before sending the whole body'))
          onDone(false)
          return
        }
        if (chunk.length > remaining) {
          controller.enqueue(chunk.subarray(0, remaining))
          connection.unread(chunk.subarray(remaining))
          remaining = 0
        } else {
          controller.enqueue(chunk)
          remaining -= chunk.length
        }
        if (remaining === 0) {
          controller.close()
          onDone(true)
        }
      },
      cancel () { onDone(false) },
    })
  }

  if (framing.kind === 'until-close') {
    return new ReadableStream<Uint8Array>({
      async pull (controller) {
        const chunk = await pull()
        if (chunk === null) {
          controller.close()
          onDone(false)   // framing was the close itself
          return
        }
        controller.enqueue(chunk)
      },
      cancel () { onDone(false) },
    })
  }

  // Chunked. Sizes arrive as hex lines; a zero-length chunk ends the body and
  // is followed by optional trailers.
  let buffer = new Uint8Array(0)
  let finished = false
  const append = (chunk: Uint8Array): void => {
    const grown = new Uint8Array(buffer.length + chunk.length)
    grown.set(buffer, 0)
    grown.set(chunk, buffer.length)
    buffer = grown
  }
  const lineEnd = (): number => indexOfSequence(buffer, new Uint8Array([13, 10]), 0)

  return new ReadableStream<Uint8Array>({
    async pull (controller) {
      while (true) {
        if (finished) {
          controller.close()
          onDone(true)
          return
        }
        let separator = lineEnd()
        while (separator < 0) {
          const chunk = await pull()
          if (chunk === null) {
            controller.error(new HttpError('the container closed the connection mid-chunk'))
            onDone(false)
            return
          }
          append(chunk)
          separator = lineEnd()
        }
        const header = new TextDecoder().decode(buffer.subarray(0, separator))
        const size = Number.parseInt(header.split(';', 1)[0]!.trim(), 16)
        if (!Number.isFinite(size) || size < 0) {
          controller.error(new HttpError('the container sent a malformed chunk size: ' + JSON.stringify(header)))
          onDone(false)
          return
        }
        buffer = buffer.subarray(separator + 2)

        if (size === 0) {
          finished = true
          continue
        }
        while (buffer.length < size + 2) {
          const chunk = await pull()
          if (chunk === null) {
            controller.error(new HttpError('the container closed the connection mid-chunk'))
            onDone(false)
            return
          }
          append(chunk)
        }
        controller.enqueue(buffer.slice(0, size))
        buffer = buffer.subarray(size + 2)
        return
      }
    },
    cancel () { onDone(false) },
  })
}

const encodeBody = async (body: BodyInit | null | undefined): Promise<Uint8Array | null> => {
  if (body === null || body === undefined) return null
  if (typeof body === 'string') return new TextEncoder().encode(body)
  if (body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  return new Uint8Array(await new Response(body).arrayBuffer())
}

export type HttpClientOptions = {
  connectTimeoutMs?: number
  responseTimeoutMs?: number
}

export class HttpClient {
  private pool = new Pool()
  private connectTimeoutMs: number
  private responseTimeoutMs: number

  constructor (options: HttpClientOptions = {}) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000
    this.responseTimeoutMs = options.responseTimeoutMs ?? 30_000
  }

  close (): void {
    this.pool.clear()
  }

  async fetch (url: URL, init: RequestInit = {}): Promise<Response> {
    const request = new Request(url, init)
    const body = await encodeBody(init.body ?? null)
    const endpoint: HttpEndpoint = {
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    }

    let attempt = 0
    while (true) {
      const pooled = this.pool.take(endpoint)
      const connection = pooled ?? await Connection.open(endpoint, this.connectTimeoutMs, request.signal)
      try {
        return await this.exchange(connection, url, request, body)
      } catch (error) {
        connection.destroy()
        const retryable = pooled !== null && attempt === 0 &&
          connection.bytesRead === 0 &&
          !(error instanceof DOMException && error.name === 'AbortError')
        if (!retryable) throw error
        attempt++
      }
    }
  }

  private async exchange (
    connection: Connection,
    url: URL,
    request: Request,
    body: Uint8Array | null,
  ): Promise<Response> {
    const method = request.method.toUpperCase()
    const headers = new Headers(request.headers)
    if (!headers.has('host')) headers.set('host', url.host)
    if (!headers.has('accept')) headers.set('accept', '*/*')
    headers.set('connection', 'keep-alive')
    headers.delete('transfer-encoding')
    if (body) headers.set('content-length', String(body.byteLength))
    else if (method === 'POST' || method === 'PUT' || method === 'PATCH') headers.set('content-length', '0')

    let head = method + ' ' + (url.pathname || '/') + url.search + ' HTTP/1.1' + CRLF
    headers.forEach((value, name) => { head += name + ': ' + value + CRLF })
    head += CRLF

    const headBytes = new TextEncoder().encode(head)
    if (body && body.byteLength > 0) {
      const packet = new Uint8Array(headBytes.length + body.byteLength)
      packet.set(headBytes, 0)
      packet.set(body, headBytes.length)
      connection.write(packet)
    } else {
      connection.write(headBytes)
    }

    let parsed = await readHead(connection, this.responseTimeoutMs, request.signal)
    // 1xx responses are informational; the real one follows on the same socket.
    while (parsed.status >= 100 && parsed.status < 200) {
      connection.unread(parsed.rest)
      parsed = await readHead(connection, this.responseTimeoutMs, request.signal)
    }

    const framing = framingFor(method, parsed)
    const wantsClose = (parsed.headers.get('connection') || '').toLowerCase().includes('close') ||
      parsed.httpVersion === '1.0'

    const settle = (reusable: boolean): void => {
      if (reusable && !wantsClose) this.pool.give(connection)
      else connection.destroy()
    }

    const stream = bodyStream(connection, framing, parsed, this.responseTimeoutMs, settle, request.signal)

    // `Response` rejects a body on these statuses even when one was framed.
    const bodyless = parsed.status === 204 || parsed.status === 205 || parsed.status === 304
    return new Response(bodyless ? null : stream, {
      status: parsed.status,
      statusText: parsed.statusText,
      headers: parsed.headers,
    })
  }
}
