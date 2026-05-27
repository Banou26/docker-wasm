// In-browser Docker Registry V2 client + docker-archive (USTAR) assembler.
//
// Docker Hub doesn't send CORS headers, so we route through @fkn/lib's
// serverProxyFetch — the page's /proxy endpoint speaks the fkn-proxy-*
// protocol and pass-throughs to upstream registries.
//
// Result of pullImage() is a Uint8Array containing a docker-archive tar (the
// format `docker save` writes; `buildah pull docker-archive:` reads), which
// the runtime serves to the c2w-webvpn-proxy worker via a wasmimport so the
// guest can wget it and feed it to buildah.

import { serverProxyFetch } from '@fkn/lib'

export type Platform = { os: string; arch: string }

export type PullOptions = {
  onLog?: (s: string) => void
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

const proxyFetch = async (url: string, opts: ProxyFetchInit = {}): Promise<FetchResult> => {
  const r = await serverProxyFetch(url, {
    method: opts.method || 'GET',
    headers: opts.headers,
    body: opts.body,
  })
  const headers: Record<string, string> = {}
  r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v })
  // serverProxyFetch loses Response.status when it rebuilds the Response;
  // our /proxy shim smuggles the real upstream status through the headers
  // envelope as x-upstream-status.
  const statusHeader = headers['x-upstream-status']
  const status = parseInt(statusHeader ?? String(r.status), 10)
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

const fetchToken = async (www: string, repository: string): Promise<string | null> => {
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
  const { status, body } = await proxyFetch(url.toString())
  if (status !== 200) throw new Error('token endpoint returned ' + status)
  const j = await body.json()
  return j.token || j.access_token || null
}

const getWithAuth = async (url: string, repository: string, accept?: string): Promise<FetchResult> => {
  const headers: Record<string, string> = accept ? { Accept: accept } : {}
  let r = await proxyFetch(url, { headers })
  if (r.status === 401) {
    const token = await fetchToken(r.headers['www-authenticate'] || '', repository)
    if (!token) throw new Error('no bearer auth on ' + url)
    headers.Authorization = 'Bearer ' + token
    r = await proxyFetch(url, { headers })
  }
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

const getBlobBytes = async (registry: string, repository: string, digest: string): Promise<Uint8Array> => {
  const url = 'https://' + registry + '/v2/' + repository + '/blobs/' + digest
  const r = await getWithAuth(url, repository)
  if (r.status !== 200) throw new Error('blob ' + digest + ' -> ' + r.status)
  const ab = await r.body.arrayBuffer()
  return new Uint8Array(ab)
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

export const pullImage = async (ref: string, opts: PullOptions = {}): Promise<Uint8Array> => {
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

  // Step 2: config blob.
  onLog('fetch config ' + mj.config.digest)
  const configBytes = await getBlobBytes(registry, repository, mj.config.digest)
  const configName = mj.config.digest.replace(/^sha256:/, '') + '.json'

  // Step 3: layer blobs. docker-archive layer dir = layer digest minus "sha256:".
  // skopeo (which buildah uses to read docker-archive:) accepts gzipped layers.
  type LayerEntry = { dir: string; file: string; bytes: Uint8Array }
  const layerEntries: LayerEntry[] = []
  for (let i = 0; i < mj.layers.length; i++) {
    const l = mj.layers[i]
    onLog('fetch layer ' + (i + 1) + '/' + mj.layers.length + ' ' + l.digest + ' (' + Math.round(l.size / 1024) + ' KiB)')
    const bytes = await getBlobBytes(registry, repository, l.digest)
    layerEntries.push({ dir: l.digest.replace(/^sha256:/, ''), file: 'layer.tar', bytes })
  }

  // Step 4: assemble docker-archive tar.
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
