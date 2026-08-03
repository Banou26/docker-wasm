// Sweeping for markers in the guest after the fact is not equivalent: it cannot tell an opaque directory's own contents (which stay) from the lower layer's (which go).

const BLOCK = 512

export type LayerOps = {
  removals: string[]
  emptied: string[]
  markers: string[]
  compression: 'gzip' | 'none'
}

class ByteQueue {
  private chunks: Uint8Array[] = []
  private offset = 0
  private available = 0

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.available += chunk.length
  }

  get length(): number {
    return this.available
  }

  take(count: number): Uint8Array | null {
    if (this.available < count) return null
    const out = new Uint8Array(count)
    let written = 0
    while (written < count) {
      const chunk = this.chunks[0]!
      const from = chunk.subarray(this.offset, this.offset + (count - written))
      out.set(from, written)
      written += from.length
      this.offset += from.length
      if (this.offset >= chunk.length) {
        this.chunks.shift()
        this.offset = 0
      }
    }
    this.available -= count
    return out
  }

  discard(count: number): number {
    let dropped = 0
    while (dropped < count && this.chunks.length > 0) {
      const chunk = this.chunks[0]!
      const step = Math.min(count - dropped, chunk.length - this.offset)
      this.offset += step
      dropped += step
      if (this.offset >= chunk.length) {
        this.chunks.shift()
        this.offset = 0
      }
    }
    this.available -= dropped
    return dropped
  }
}

// tar stores numbers as octal text, sometimes space padded, sometimes NUL terminated, and occasionally both.
const parseOctal = (bytes: Uint8Array): number => {
  let text = ''
  for (const byte of bytes) {
    if (byte === 0 || byte === 0x20) {
      if (text) break
      continue
    }
    text += String.fromCharCode(byte)
  }
  const value = parseInt(text, 8)
  return Number.isFinite(value) ? value : 0
}

const decodeString = (bytes: Uint8Array): string => {
  const end = bytes.indexOf(0)
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end))
}

export const normalisePath = (name: string): string | null => {
  const segments: string[] = []
  for (const segment of name.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.length > 0 ? segments.join('/') : null
}

export type TarEntry = { path: string; kind: 'dir' | 'file' }

const walkTar = async (
  stream: ReadableStream<Uint8Array>,
  onEntry: (entry: TarEntry) => void,
): Promise<void> => {
  const reader = stream.getReader()
  const queue = new ByteQueue()
  let skip = 0
  let pending: { type: string; size: number; padded: number } | null = null
  let longName: string | null = null
  let paxPath: string | null = null

  const drain = (): void => {
    for (;;) {
      if (skip > 0) {
        skip -= queue.discard(skip)
        if (skip > 0) return
      }
      if (pending) {
        const data = queue.take(pending.padded)
        if (!data) return
        const text = decodeString(data.subarray(0, pending.size))
        if (pending.type === 'L') {
          longName = text
        } else {
          // pax records are `<length> <key>=<value>\n`, and `path` overrides the 100-byte name field.
          const match = /(?:^|\n)\d+ path=([^\n]*)/.exec(text)
          if (match) paxPath = match[1]!
        }
        pending = null
        continue
      }

      const header = queue.take(BLOCK)
      if (!header) return
      // Two zero blocks end the archive, but trailing garbage is common enough that skipping any zero block is safer than stopping on the first.
      if (header.every((byte) => byte === 0)) continue

      const size = parseOctal(header.subarray(124, 136))
      const padded = Math.ceil(size / BLOCK) * BLOCK
      const type = String.fromCharCode(header[156]!)

      if (type === 'L' || type === 'x' || type === 'X') {
        if (padded > 1 << 16) {
          skip = padded
          continue
        }
        pending = { type: type === 'L' ? 'L' : 'x', size, padded }
        continue
      }
      if (type === 'g') {
        skip = padded
        continue
      }

      const rawName = longName ?? paxPath ?? (() => {
        const prefix = decodeString(header.subarray(345, 500))
        const name = decodeString(header.subarray(0, 100))
        return prefix ? prefix + '/' + name : name
      })()
      longName = null
      paxPath = null

      const path = normalisePath(rawName)
      if (path) onEntry({ path, kind: type === '5' ? 'dir' : 'file' })
      skip = padded
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (value) {
      queue.push(value)
      drain()
    }
    if (done) break
  }
}

const GZIP_MAGIC = [0x1f, 0x8b]

const layerStream = (bytes: Uint8Array): { stream: ReadableStream<Uint8Array>; compression: 'gzip' | 'none' } => {
  const gzipped = bytes.length >= 2 && bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1]
  // A copy the Blob owns, because the caller keeps the original to hand to the guest and a detached buffer would take that with it.
  const source = new Blob([bytes.slice().buffer as ArrayBuffer]).stream() as ReadableStream<Uint8Array>
  if (!gzipped) return { stream: source, compression: 'none' }
  const gunzip = new DecompressionStream('gzip') as unknown as
    ReadableWritablePair<Uint8Array, Uint8Array>
  return { stream: source.pipeThrough(gunzip), compression: 'gzip' }
}

export const scanLayers = async (layers: Uint8Array[]): Promise<LayerOps[]> => {
  const kinds = new Map<string, 'dir' | 'file'>()
  const results: LayerOps[] = []

  for (const bytes of layers) {
    const { stream, compression } = layerStream(bytes)
    const ops: LayerOps = { removals: [], emptied: [], markers: [], compression }
    const introduced: TarEntry[] = []

    await walkTar(stream, (entry) => {
      const slash = entry.path.lastIndexOf('/')
      const directory = slash === -1 ? '' : entry.path.slice(0, slash)
      const base = slash === -1 ? entry.path : entry.path.slice(slash + 1)

      if (base === '.wh..wh..opq') {
        ops.emptied.push(directory)
        ops.markers.push(entry.path)
        const prefix = directory ? directory + '/' : ''
        for (const known of [...kinds.keys()]) {
          if (known.startsWith(prefix) && known !== directory) kinds.delete(known)
        }
        return
      }
      if (base.startsWith('.wh.')) {
        const target = directory ? directory + '/' + base.slice(4) : base.slice(4)
        ops.removals.push(target)
        ops.markers.push(entry.path)
        kinds.delete(target)
        for (const known of [...kinds.keys()]) {
          if (known.startsWith(target + '/')) kinds.delete(known)
        }
        return
      }

      // A path that changes type has to be removed first: tar merges into a directory rather than replacing it, and fails outright writing a directory over a file.
      const previous = kinds.get(entry.path)
      if (previous && previous !== entry.kind) ops.removals.push(entry.path)
      introduced.push(entry)
    })

    for (const entry of introduced) kinds.set(entry.path, entry.kind)
    results.push(ops)
  }

  return results
}
