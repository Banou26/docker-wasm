// control is 0 = request in flight, 1 = reply ready; status is negative = error, otherwise request specific

export const STREAM_HEADER_BYTES = 12
export const STREAM_DATA_BYTES = 64 * 1024
export const STREAM_BUFFER_BYTES = STREAM_HEADER_BYTES + STREAM_DATA_BYTES

// the TTY channel uses its own buffer with a simpler layout inherited from xterm-pty: a control word followed by an Int32 payload array
export const TTY_BUFFER_BYTES = 4 + 4 * 1024

export type StreamView = {
  control: Int32Array
  status: Int32Array
  length: Int32Array
  data: Uint8Array
}

export const viewStream = (shared: SharedArrayBuffer): StreamView => ({
  control: new Int32Array(shared, 0, 1),
  status: new Int32Array(shared, 4, 1),
  length: new Int32Array(shared, 8, 1),
  data: new Uint8Array(shared, STREAM_HEADER_BYTES),
})

export type GuestWorkerInit = {
  type: 'init'
  stream: SharedArrayBuffer
  tty: SharedArrayBuffer
  image: string | ArrayBuffer
  network: boolean
}

export type NetstackWorkerInit = {
  type: 'init'
  stream: SharedArrayBuffer
  image: string | ArrayBuffer
  ingress: boolean
}

export type TtyRequest =
  | { ttyRequestType: 'read'; length: number }
  | { ttyRequestType: 'write'; buf: number[] }
  | { ttyRequestType: 'poll'; timeout: number }
  | { ttyRequestType: 'tcgets' }
  | { ttyRequestType: 'tcsets'; data: number[] }
  | { ttyRequestType: 'tiocgwinsz' }

export type WorkerStage = 'fetching' | 'compiled' | 'started' | 'exited'

export type WorkerStatus =
  | { type: 'status'; stage: WorkerStage; elapsedMs: number; bytes?: number }
  | { type: 'error'; message: string }

export const isTtyRequest = (value: unknown): value is TtyRequest =>
  typeof value === 'object' && value !== null &&
  typeof (value as { ttyRequestType?: unknown }).ttyRequestType === 'string'
