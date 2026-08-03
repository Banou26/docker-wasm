import { FrameBridge } from './frame-bridge'
import { HttpClient } from './http'
import {
  createNetstack,
  type ArtifactCache,
  type Netstack,
  type PublishedPort,
} from './netstack'
import { isTtyRequest, type GuestWorkerInit, type NetstackWorkerInit, type WorkerStatus } from './protocol'
import { TtyHost } from './tty-host'

export type ContainerImage = string | URL | ArrayBuffer | ArrayBufferView

export type ContainerOptions = {
  image: ContainerImage
  netstackImage?: ContainerImage
  ports?: number[]
  network?: boolean
  columns?: number
  rows?: number
  onLog?: (bytes: Uint8Array) => void
  onStatus?: (status: ContainerStatus) => void
  startupGraceMs?: number
  connectTimeoutMs?: number
  responseTimeoutMs?: number
  // Files the page offers to the guest over its local gateway. The Dockerfile builder image uses this; prebuilt images never touch it.
  artifacts?: ArtifactCache
  dnsResolver?: (query: Uint8Array) => Promise<Uint8Array>
}

export type ContainerSource = 'guest' | 'netstack'

export type ContainerStatus =
  | { phase: 'starting'; source?: ContainerSource }
  | { phase: 'fetching'; source: ContainerSource; elapsedMs: number; bytes?: number }
  | { phase: 'compiled'; source: ContainerSource; elapsedMs: number; bytes?: number }
  | { phase: 'running'; source: ContainerSource; elapsedMs: number }
  | { phase: 'serving'; elapsedMs: number }
  | { phase: 'stopped'; source?: ContainerSource }
  | { phase: 'failed'; error: Error }

export type ContainerPort = {
  guestPort: number
  host: string
  port: number
  origin: string
}

const DEFAULT_NETSTACK_IMAGE = new URL('./c2w-webvpn-proxy.wasm', import.meta.url).href

const toWasmSource = (image: ContainerImage): string | ArrayBuffer => {
  if (typeof image === 'string') return new URL(image, location.href).href
  if (image instanceof URL) return image.href
  if (image instanceof ArrayBuffer) return image
  return image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength) as ArrayBuffer
}

const originOf = (port: PublishedPort): string => {
  const host = port.host.includes(':') ? '[' + port.host + ']' : port.host
  return 'http://' + host + ':' + port.port
}

export class Container {
  private tty: TtyHost
  private bridge: FrameBridge
  private netstack: Netstack | null = null
  private http: HttpClient
  private guestWorker: Worker | null = null
  private netstackWorker: Worker | null = null
  private published = new Map<number, PublishedPort>()
  private startedAt = performance.now()
  private stopping: Promise<void> | null = null
  private failure: Error | null = null
  private serving = false
  private readonly startupGraceMs: number
  private readonly onStatus: (status: ContainerStatus) => void
  private logListeners = new Set<(bytes: Uint8Array) => void>()

  readonly ready: Promise<void>

  constructor (private options: ContainerOptions) {
    this.startupGraceMs = options.startupGraceMs ?? 90_000
    this.onStatus = options.onStatus ?? (() => {})
    const bridge = new FrameBridge(() => this.netstack, () => this.tty.interrupt())
    this.bridge = bridge
    this.tty = new TtyHost({
      columns: options.columns,
      rows: options.rows,
      hasPendingWork: () => bridge.guestPending > 0,
    })
    this.http = new HttpClient({
      connectTimeoutMs: options.connectTimeoutMs,
      responseTimeoutMs: options.responseTimeoutMs,
    })
    if (options.onLog) this.logListeners.add(options.onLog)
    this.tty.onOutput((bytes) => {
      for (const listener of this.logListeners) listener(bytes)
    })
    this.onStatus({ phase: 'starting' })
    this.ready = this.start().catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.failure = failure
      this.onStatus({ phase: 'failed', error: failure })
      void this.stop()
      throw failure
    })
  }

  private async start (): Promise<void> {
    const network = this.options.network !== false
    const ports = this.options.ports ?? []
    if (ports.length > 0 && !network) {
      throw new Error('publishing ports requires the container network')
    }

    if (network) {
      this.netstack = createNetstack({
        artifacts: this.options.artifacts,
        dnsResolver: this.options.dnsResolver,
        onLog: (message) => console.debug('[fkn-container]', message),
      })

      // Bind every published port before the guest boots, so a service that comes up instantly still has a route waiting.
      const bound = await Promise.all(ports.map((port) => this.netstack!.listen(port)))
      for (const port of bound) this.published.set(port.guestPort, port)

      this.netstackWorker = new Worker(new URL('./workers/netstack.worker.ts', import.meta.url), {
        type: 'module',
        name: 'fkn-container-netstack',
      })
      this.netstackWorker.onmessage = (event) => this.routeNetstackMessage(event)
      this.netstackWorker.onerror = (event) => this.fail('network stack worker failed: ' + event.message)
      const netstackInit: NetstackWorkerInit = {
        type: 'init',
        stream: this.bridge.netstackBuffer,
        image: toWasmSource(this.options.netstackImage ?? DEFAULT_NETSTACK_IMAGE),
        ingress: ports.length > 0,
      }
      this.netstackWorker.postMessage(netstackInit)
    }

    this.guestWorker = new Worker(new URL('./workers/guest.worker.ts', import.meta.url), {
      type: 'module',
      name: 'fkn-container-guest',
    })
    this.guestWorker.onmessage = (event) => this.routeGuestMessage(event)
    this.guestWorker.onerror = (event) => this.fail('container worker failed: ' + event.message)
    const guestInit: GuestWorkerInit = {
      type: 'init',
      stream: this.bridge.guestBuffer,
      tty: this.tty.buffer,
      image: toWasmSource(this.options.image),
      network,
    }
    this.guestWorker.postMessage(guestInit)
  }

  private routeGuestMessage (event: MessageEvent): void {
    const data = event.data as unknown
    if (isTtyRequest(data)) {
      this.tty.handle(data)
      return
    }
    if (this.handleStatus(data, 'guest')) return
    this.bridge.handleGuest(event)
  }

  private routeNetstackMessage (event: MessageEvent): void {
    if (this.handleStatus(event.data as unknown, 'netstack')) return
    this.bridge.handleNetstack(event)
  }

  private handleStatus (data: unknown, source: ContainerSource): boolean {
    const message = data as WorkerStatus
    if (message?.type === 'error') {
      this.fail(message.message)
      return true
    }
    if (message?.type !== 'status') return false
    const elapsedMs = this.elapsed()
    switch (message.stage) {
      case 'fetching': this.onStatus({ phase: 'fetching', source, elapsedMs, bytes: message.bytes }); break
      case 'compiled': this.onStatus({ phase: 'compiled', source, elapsedMs, bytes: message.bytes }); break
      case 'started': this.onStatus({ phase: 'running', source, elapsedMs }); break
      case 'exited': this.onStatus({ phase: 'stopped', source }); break
    }
    return true
  }

  private fail (message: string): void {
    if (this.failure) return
    this.failure = new Error(message)
    this.onStatus({ phase: 'failed', error: this.failure })
  }

  private elapsed (): number {
    return Math.round(performance.now() - this.startedAt)
  }

  get ports (): ContainerPort[] {
    return Array.from(this.published.values(), (port) => ({
      guestPort: port.guestPort,
      host: port.host,
      port: port.port,
      origin: originOf(port),
    }))
  }

  origin (guestPort?: number): string {
    const port = guestPort === undefined
      ? this.published.values().next().value
      : this.published.get(guestPort)
    if (!port) {
      throw new Error(guestPort === undefined
        ? 'this container has no published ports'
        : 'guest port ' + guestPort + ' is not published')
    }
    return originOf(port)
  }

  private resolve (input: string | URL | Request): URL {
    const raw = input instanceof Request ? input.url : String(input)
    if (/^https?:\/\//i.test(raw)) {
      const url = new URL(raw)
      const requested = Number(url.port || 80)
      const target = this.published.get(requested)
      if (target) {
        url.protocol = 'http:'
        url.hostname = target.host
        url.port = String(target.port)
        return url
      }
      for (const port of this.published.values()) {
        if (url.hostname === port.host && Number(url.port) === port.port) return url
      }
      throw new Error('no published port matches ' + raw)
    }
    return new URL(raw, this.origin() + '/')
  }

  async fetch (input: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (this.failure) throw this.failure
    if (this.stopping) throw new Error('this container has been stopped')
    await this.ready
    const url = this.resolve(input)
    const deadline = performance.now() + (this.serving ? 0 : this.startupGraceMs)
    let delayMs = 25

    while (true) {
      try {
        const response = await this.http.fetch(url, init)
        if (!this.serving) {
          this.serving = true
          this.onStatus({ phase: 'serving', elapsedMs: this.elapsed() })
        }
        return response
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        if (this.failure) throw this.failure
        if (performance.now() >= deadline) throw error
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        delayMs = Math.min(delayMs * 2, 500)
      }
    }
  }

  logs (): ReadableStream<Uint8Array> {
    let detach: (() => void) | null = null
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        const listener = (bytes: Uint8Array): void => {
          try { controller.enqueue(bytes) } catch { /* reader went away */ }
        }
        this.logListeners.add(listener)
        detach = () => this.logListeners.delete(listener)
      },
      cancel: () => { detach?.() },
    })
  }

  onLog (listener: (bytes: Uint8Array) => void): () => void {
    this.logListeners.add(listener)
    return () => { this.logListeners.delete(listener) }
  }

  write (data: string | Uint8Array): void {
    this.tty.write(data)
  }

  resize (columns: number, rows: number): void {
    this.tty.resize(columns, rows)
  }

  stop (): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopping = (async () => {
      this.http.close()
      this.tty.dispose()
      this.bridge.dispose()
      this.guestWorker?.terminate()
      this.netstackWorker?.terminate()
      this.guestWorker = null
      this.netstackWorker = null
      const netstack = this.netstack
      this.netstack = null
      this.published.clear()
      if (netstack) await netstack.close().catch(() => {})
      this.onStatus({ phase: 'stopped' })
    })()
    return this.stopping
  }
}

export const createContainer = (options: ContainerOptions): Container => new Container(options)
