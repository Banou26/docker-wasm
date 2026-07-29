// In-browser Docker Registry V2 client + docker-archive (USTAR) assembler.
//
// Docker Hub doesn't send CORS headers, so requests use FKN cloud fetch.
//
// Result of pullImage() is a Uint8Array containing a docker-archive tar (the
// format `docker save` writes; `buildah pull docker-archive:` reads), which
// the runtime serves to the c2w-webvpn-proxy worker via a wasmimport so the
// guest can wget it and feed it to buildah.

import { fetch as cloudFetch } from '@fkn/lib/cloud'

export type Platform = { os: string; arch: string }

// Layer sizes come from the manifest, so a pull knows its exact total before it
// starts and progress is real rather than a spinner.
export type PullProgress = {
  ref: string
  // Layers whose bytes have fully arrived.
  layersDone: number
  layersTotal: number
  bytesReceived: number
  bytesTotal: number
}

export type PullOptions = {
  onLog?: (s: string) => void
  onProgress?: (progress: PullProgress) => void
  platform?: Platform
}

type Ref = {
  registry: string
  repository: string
  tag: string
  digest: string
}

type FetchResult = {
  status: number
  headers: Record<string, string>
  body: Response
}

type ProxyFetchInit = {
  method?: string
  headers?: Record<string, string>
  body?: BodyInit
}

type RegistryToken = {
  value: string
  expiresAt: number
}

const registryTokens = new Map<string, RegistryToken>()
const registryTokenRequests = new Map<string, Promise<RegistryToken | null>>()

const proxyFetch = async (url: string, opts: ProxyFetchInit = {}): Promise<FetchResult> => {
  const r = await cloudFetch(url, {
    method: opts.method || 'GET',
    headers: opts.headers,
    body: opts.body,
  })
  const headers: Record<string, string> = {}
  r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v })
  const statusHeader = headers['x-upstream-status'] || headers['fkn-proxy-status']
  const status = statusHeader
    ? parseInt(statusHeader, 10)
    : r.status === 200 && headers['www-authenticate']
      ? 401
      : r.status
  return { status, headers, body: r }
}

// alpine                          -> registry-1.docker.io / library/alpine : latest
// alpine:3.19                     -> registry-1.docker.io / library/alpine : 3.19
// ghcr.io/foo/bar:tag             -> ghcr.io / foo/bar : tag
// public.ecr.aws/docker/library/alpine:3.19 -> public.ecr.aws / docker/library/alpine : 3.19
export const parseRef = (ref: string): Ref => {
  let registry = 'registry-1.docker.io'
  let path = ref
  const firstSlash = ref.indexOf('/')
  if (firstSlash !== -1) {
    const head = ref.slice(0, firstSlash)
    if (head.includes('.') || head.includes(':') || head === 'localhost') {
      registry = head
      path = ref.slice(firstSlash + 1)
    }
  }
  let tag = 'latest'
  let digest = ''
  const atIdx = path.indexOf('@')
  if (atIdx !== -1) {
    digest = path.slice(atIdx + 1)
    path = path.slice(0, atIdx)
  }
  const colonIdx = path.lastIndexOf(':')
  const slashAfterColon = colonIdx !== -1 && path.indexOf('/', colonIdx) !== -1
  if (colonIdx !== -1 && !slashAfterColon) {
    tag = path.slice(colonIdx + 1)
    path = path.slice(0, colonIdx)
  }
  if (registry === 'registry-1.docker.io' && !path.includes('/')) {
    path = 'library/' + path
  }
  return { registry, repository: path, tag, digest }
}

const fetchToken = async (www: string, repository: string, cacheKey: string): Promise<string | null> => {
  const pending = registryTokenRequests.get(cacheKey)
  if (pending) return (await pending)?.value || null

  // www: 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"'
  const m = www.match(/Bearer\s+(.+)/i)
  if (!m) return null
  const params: Record<string, string> = {}
  m[1]!.split(',').forEach((kv) => {
    const eq = kv.indexOf('=')
    if (eq === -1) return
    const k = kv.slice(0, eq).trim()
    const v = kv.slice(eq + 1).trim().replace(/^"|"$/g, '')
    params[k] = v
  })
  if (!params.realm) return null
  const url = new URL(params.realm)
  if (params.service) url.searchParams.set('service', params.service)
  url.searchParams.set('scope', 'repository:' + repository + ':pull')
  url.searchParams.set('_fkn', crypto.randomUUID())
  const request = (async (): Promise<RegistryToken | null> => {
    const { status, body } = await proxyFetch(url.toString())
    if (status !== 200) throw new Error('token endpoint returned ' + status)
    const j = await body.json() as { token?: string; access_token?: string; expires_in?: number }
    const value = j.token || j.access_token
    if (!value) return null
    const expiresIn = Number(j.expires_in)
    const ttlSeconds = Number.isFinite(expiresIn) ? Math.max(1, expiresIn - 30) : 240
    const token = { value, expiresAt: Date.now() + ttlSeconds * 1000 }
    registryTokens.set(cacheKey, token)
    return token
  })()
  registryTokenRequests.set(cacheKey, request)
  try {
    return (await request)?.value || null
  } finally {
    registryTokenRequests.delete(cacheKey)
  }
}

const getWithAuth = async (url: string, repository: string, accept?: string): Promise<FetchResult> => {
  const headers: Record<string, string> = accept ? { Accept: accept } : {}
  const cacheKey = new URL(url).origin + '|' + repository
  const cachedToken = registryTokens.get(cacheKey)
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    headers.Authorization = 'Bearer ' + cachedToken.value
  } else if (cachedToken) {
    registryTokens.delete(cacheKey)
  }
  let r = await proxyFetch(url, { headers })
  if (r.status === 401) {
    const failedToken = cachedToken?.value
    const currentToken = registryTokens.get(cacheKey)
    if (failedToken && currentToken?.value === failedToken) registryTokens.delete(cacheKey)
    const replacement = registryTokens.get(cacheKey)
    const token = replacement && replacement.expiresAt > Date.now()
      ? replacement.value
      : await fetchToken(r.headers['www-authenticate'] || '', repository, cacheKey)
    if (!token) throw new Error('no bearer auth on ' + url)
    headers.Authorization = 'Bearer ' + token
    r = await proxyFetch(url, { headers })
  }
  let currentUrl = url
  for (let redirects = 0; redirects < 5 && r.headers.location; redirects++) {
    const nextUrl = new URL(r.headers.location, currentUrl).toString()
    if (new URL(nextUrl).origin !== new URL(currentUrl).origin) delete headers.Authorization
    currentUrl = nextUrl
    r = await proxyFetch(currentUrl, { headers })
  }
  if (r.headers.location) throw new Error('too many redirects for ' + url)
  return r
}

const ACCEPT_MANIFESTS = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

type ManifestResp = { type: string; body: string; digest: string | undefined }

const getManifest = async (registry: string, repository: string, reference: string): Promise<ManifestResp> => {
  const url = 'https://' + registry + '/v2/' + repository + '/manifests/' + encodeURIComponent(reference)
  const r = await getWithAuth(url, repository, ACCEPT_MANIFESTS)
  if (r.status !== 200) throw new Error('manifest ' + reference + ' -> ' + r.status)
  const ct = (r.headers['content-type'] || '').toLowerCase()
  const text = await r.body.text()
  return { type: ct, body: text, digest: r.headers['docker-content-digest'] }
}

type ManifestEntry = {
  digest: string
  platform: { architecture: string; os: string }
}

const pickPlatform = (index: string, want: Platform): ManifestEntry | null => {
  const j = JSON.parse(index)
  if (!j.manifests || !Array.isArray(j.manifests)) return null
  const wantArch = want.arch || 'amd64'
  const wantOs = want.os || 'linux'
  return j.manifests.find((m: ManifestEntry) =>
    m.platform && m.platform.architecture === wantArch && m.platform.os === wantOs)
    || j.manifests.find((m: ManifestEntry) =>
      m.platform && m.platform.architecture === wantArch)
    || null
}

// The platforms a reference publishes. Manifest list only, so it is one small
// request and cheap enough to run while someone is still typing. A single-platform
// image reports the one it is, read from its config.
export const manifestPlatforms = async (ref: string): Promise<Platform[]> => {
  const { registry, repository, tag, digest } = parseRef(ref)
  const m = await getManifest(registry, repository, digest || tag)
  const isList = m.type.includes('manifest.list') || m.type.includes('image.index')
  const parsed = JSON.parse(m.body)

  if (isList) {
    if (!Array.isArray(parsed.manifests)) return []
    return parsed.manifests
      .filter((entry: ManifestEntry) => entry.platform)
      // Attestation manifests ride along in the same list with a placeholder
      // architecture; they are not something anything can run.
      .filter((entry: ManifestEntry) => entry.platform.architecture !== 'unknown')
      .map((entry: ManifestEntry) => ({ os: entry.platform.os, arch: entry.platform.architecture }))
  }

  if (!parsed.config?.digest) return []
  const config = JSON.parse(new TextDecoder().decode(
    await getBlobBytes(registry, repository, parsed.config.digest),
  ))
  return config.architecture ? [{ os: config.os || 'linux', arch: config.architecture }] : []
}

const getBlobBytes = async (
  registry: string,
  repository: string,
  digest: string,
  onBytes?: (delta: number) => void,
): Promise<Uint8Array> => {
  const url = 'https://' + registry + '/v2/' + repository + '/blobs/' + digest
  const r = await getWithAuth(url, repository)
  if (r.status !== 200) throw new Error('blob ' + digest + ' -> ' + r.status)
  // Without a progress callback there is nothing to gain from streaming, and
  // arrayBuffer() is the faster path.
  if (!onBytes || !r.body.body) {
    const ab = await r.body.arrayBuffer()
    return new Uint8Array(ab)
  }

  const reader = r.body.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.length
    onBytes(value.length)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length }
  return out
}

const mapConcurrent = async <T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await task(items[index]!, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// ---- USTAR writer: plain files + directory-implied paths only.

const BLOCK = 512
const octal = (n: number, w: number): string => {
  const s = n.toString(8)
  return '0'.repeat(Math.max(0, w - 1 - s.length)) + s + ' '
}
const pad = (arr: Uint8Array, off: number, len: number, str: string): void => {
  for (let i = 0; i < len && i < str.length; i++) arr[off + i] = str.charCodeAt(i)
}
const tarHeader = (name: string, size: number, mode = 0o644): Uint8Array => {
  const buf = new Uint8Array(BLOCK)
  pad(buf, 0, 100, name)
  pad(buf, 100, 8, octal(mode, 8))
  pad(buf, 108, 8, octal(0, 8))
  pad(buf, 116, 8, octal(0, 8))
  pad(buf, 124, 12, octal(size, 12))
  pad(buf, 136, 12, octal(Math.floor(Date.now() / 1000), 12))
  pad(buf, 148, 8, '        ')
  buf[156] = 0x30
  pad(buf, 257, 6, 'ustar\0')
  pad(buf, 263, 2, '00')
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += buf[i]!
  pad(buf, 148, 8, octal(sum, 8))
  return buf
}
const tarFile = (name: string, bytes: Uint8Array, mode?: number): Uint8Array[] => {
  const out: Uint8Array[] = []
  out.push(tarHeader(name, bytes.length, mode))
  out.push(bytes)
  const rem = (BLOCK - (bytes.length % BLOCK)) % BLOCK
  if (rem) out.push(new Uint8Array(rem))
  return out
}
const concat = (parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

// Config fields the fast path applies itself, since it never builds an image for
// anything else to read them from.
export type ImageConfig = {
  Env?: string[]
  Cmd?: string[]
  Entrypoint?: string[]
  WorkingDir?: string
}

export type FetchedImage = {
  configBytes: Uint8Array
  configDigest: string
  // Gzipped layer tars in application order.
  layers: Array<{ digest: string; bytes: Uint8Array }>
  registry: string
  repository: string
  tag: string
}

// Everything both callers need: the manifest walk and the blob fetches. What
// they do with the result differs, and that difference is the whole point of the
// fast path, so it does not belong in here.
const fetchImage = async (ref: string, opts: PullOptions = {}): Promise<FetchedImage> => {
  const onLog = opts.onLog || (() => {})
  const platform = opts.platform || { os: 'linux', arch: 'amd64' }
  const { registry, repository, tag, digest } = parseRef(ref)
  const reference = digest || tag
  onLog('resolving ' + ref + ' -> ' + registry + '/' + repository + ':' + reference)

  // Step 1: manifest. May be a manifest list -> follow.
  let m = await getManifest(registry, repository, reference)
  const isList = m.type.includes('manifest.list') || m.type.includes('image.index')
  if (isList) {
    const pick = pickPlatform(m.body, platform)
    if (!pick) throw new Error('no manifest for platform ' + JSON.stringify(platform))
    onLog('manifest list -> picked ' + pick.platform.os + '/' + pick.platform.architecture + ' (' + pick.digest + ')')
    m = await getManifest(registry, repository, pick.digest)
  }
  const mj = JSON.parse(m.body)
  if (!mj.config || !Array.isArray(mj.layers)) throw new Error('unsupported manifest schema')

  // Step 2: fetch the config and layers concurrently while preserving order.
  onLog('fetch config ' + mj.config.digest)
  const configPromise = getBlobBytes(registry, repository, mj.config.digest)
  const configName = mj.config.digest.replace(/^sha256:/, '') + '.json'

  type BlobDescriptor = { digest: string; size: number }
  const layers = mj.layers as BlobDescriptor[]
  const bytesTotal = layers.reduce((sum, l) => sum + (l.size || 0), 0)
  let bytesReceived = 0
  let layersDone = 0
  const report = (): void => {
    opts.onProgress?.({
      ref,
      layersDone,
      layersTotal: layers.length,
      // Concurrent layers can overshoot the manifest total slightly if a registry
      // reports a stale size; clamp so a progress bar never runs past its end.
      bytesReceived: Math.min(bytesReceived, bytesTotal),
      bytesTotal,
    })
  }
  report()
  const layerBytesPromise = mapConcurrent(layers, 3, async (l, i) => {
    onLog('fetch layer ' + (i + 1) + '/' + mj.layers.length + ' ' + l.digest + ' (' + Math.round(l.size / 1024) + ' KiB)')
    const bytes = await getBlobBytes(registry, repository, l.digest, (delta) => {
      bytesReceived += delta
      report()
    })
    layersDone++
    report()
    return { digest: l.digest, bytes }
  })
  const [configBytes, fetchedLayers] = await Promise.all([configPromise, layerBytesPromise])
  return {
    configBytes,
    configDigest: mj.config.digest as string,
    layers: fetchedLayers,
    registry,
    repository,
    tag,
  }
}

// The base image as the fast path wants it: layers to untar in order, plus the
// config whose Env, WorkingDir, Cmd and Entrypoint the Dockerfile may override.
export type PulledRootfs = { layers: Uint8Array[]; config: ImageConfig }

export const pullRootfs = async (ref: string, opts: PullOptions = {}): Promise<PulledRootfs> => {
  const image = await fetchImage(ref, opts)
  let config: ImageConfig = {}
  try {
    config = (JSON.parse(new TextDecoder().decode(image.configBytes)).config ?? {}) as ImageConfig
  } catch {
    // A config we cannot read costs the image's own defaults, not the build:
    // the Dockerfile's own CMD/ENV still apply.
    opts.onLog?.('image config could not be parsed, continuing without its defaults')
  }
  opts.onLog?.('rootfs ready: ' + image.layers.length + ' layer(s)')
  return { layers: image.layers.map((layer) => layer.bytes), config }
}

// The base image as buildah wants it: a docker-archive, the format `docker save`
// writes and `buildah pull docker-archive:` reads.
export const pullImage = async (ref: string, opts: PullOptions = {}): Promise<Uint8Array> => {
  const onLog = opts.onLog || (() => {})
  const { configBytes, configDigest, layers: fetchedLayers, registry, repository, tag } =
    await fetchImage(ref, opts)
  const configName = configDigest.replace(/^sha256:/, '') + '.json'
  // docker-archive layer dir = layer digest minus "sha256:".
  // skopeo (which buildah uses to read docker-archive:) accepts gzipped layers.
  const layerEntries = fetchedLayers.map((layer) => ({
    dir: layer.digest.replace(/^sha256:/, ''),
    file: 'layer.tar',
    bytes: layer.bytes,
  }))

  const parts: Uint8Array[] = []
  parts.push(...tarFile(configName, configBytes))
  for (const e of layerEntries) {
    parts.push(...tarFile(e.dir + '/' + e.file, e.bytes))
  }
  const manifestJson = JSON.stringify([{
    Config: configName,
    RepoTags: [registry + '/' + repository + ':' + tag],
    Layers: layerEntries.map((e) => e.dir + '/' + e.file),
  }])
  parts.push(...tarFile('manifest.json', new TextEncoder().encode(manifestJson)))
  const last = layerEntries[layerEntries.length - 1]
  const repositoriesJson = JSON.stringify({
    [registry + '/' + repository]: { [tag]: last ? last.dir : '' },
  })
  parts.push(...tarFile('repositories', new TextEncoder().encode(repositoriesJson)))
  // tar EOF: two empty 512-byte blocks
  parts.push(new Uint8Array(BLOCK * 2))

  const archive = concat(parts)
  onLog('docker-archive ready: ' + archive.length + ' bytes')
  return archive
}

export const dockerfileFromRefs = (text: string): string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  for (let line of text.split('\n')) {
    line = line.replace(/^\s+|\s+$/g, '')
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^FROM\s+(?:--\S+\s+)*(\S+)/i)
    if (m) {
      const ref = m[1]!
      if (ref.toLowerCase() === 'scratch') continue
      if (!seen.has(ref)) { seen.add(ref); out.push(ref) }
    }
  }
  return out
}
