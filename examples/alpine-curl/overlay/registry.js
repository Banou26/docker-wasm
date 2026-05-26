// In-browser Docker Registry V2 client + docker-archive (USTAR) assembler.
//
// Docker Hub doesn't send CORS headers, so we go through the playground's
// /proxy endpoint — a 1:1 byte-pass-through that adds Access-Control-Allow-*.
//
// Result of pullImage() is a Uint8Array containing a docker-archive tar (the
// format `docker save` writes; `buildah pull docker-archive:` reads), which we
// then hand to the guest via a wasmimport and feed to buildah.

(function () {
    'use strict'

    // ---- HTTP helpers ----------------------------------------------------
    //
    // We route every registry request through @fkn/lib's serverProxyFetch
    // (exposed as window.webvpnProxyFetch by webvpn-bundle.js). That handles
    // CORS-blocked endpoints like Docker Hub via the fkn-proxy-* server shim.
    async function proxyFetch(url, opts = {}) {
        if (typeof globalThis.webvpnProxyFetch !== 'function') {
            throw new Error('webvpnProxyFetch not loaded (bundle did not expose @fkn/lib serverProxyFetch)')
        }
        const r = await globalThis.webvpnProxyFetch(url, {
            method:  opts.method  || 'GET',
            headers: opts.headers || undefined,
            body:    opts.body    || undefined,
        })
        const headers = {}
        r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v })
        // serverProxyFetch loses Response.status when it rebuilds the Response;
        // our /proxy shim smuggles the real upstream status through the
        // headers envelope as x-upstream-status.
        const status = parseInt(headers['x-upstream-status'] || r.status, 10)
        return { status, headers, body: r }
    }

    // ---- Image-reference parsing -----------------------------------------

    // alpine                          -> registry-1.docker.io / library/alpine : latest
    // alpine:3.19                     -> registry-1.docker.io / library/alpine : 3.19
    // library/alpine:3.19             -> registry-1.docker.io / library/alpine : 3.19
    // ghcr.io/foo/bar:tag             -> ghcr.io / foo/bar : tag
    // public.ecr.aws/docker/library/alpine:3.19 -> public.ecr.aws / docker/library/alpine : 3.19
    function parseRef(ref) {
        let registry = 'registry-1.docker.io'
        let path = ref
        const firstSlash = ref.indexOf('/')
        // registry detection: contains "." or ":" before the first / OR is "localhost(:port)"
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

    // ---- Token auth ------------------------------------------------------

    async function fetchToken(www, repository) {
        // www: 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"'
        const m = www.match(/Bearer\s+(.+)/i)
        if (!m) return null
        const params = {}
        m[1].split(',').forEach((kv) => {
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
        return j.token || j.access_token
    }

    async function getWithAuth(url, repository, accept) {
        const headers = accept ? { Accept: accept } : {}
        let r = await proxyFetch(url, { headers })
        if (r.status === 401) {
            const token = await fetchToken(r.headers['www-authenticate'] || '', repository)
            if (!token) throw new Error('no bearer auth on ' + url)
            headers.Authorization = 'Bearer ' + token
            r = await proxyFetch(url, { headers })
        }
        return r
    }

    // ---- Registry V2 fetch -----------------------------------------------

    const ACCEPT_MANIFESTS = [
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.docker.distribution.manifest.v2+json',
    ].join(', ')

    async function getManifest(registry, repository, reference) {
        const url = 'https://' + registry + '/v2/' + repository + '/manifests/' + encodeURIComponent(reference)
        const r = await getWithAuth(url, repository, ACCEPT_MANIFESTS)
        if (r.status !== 200) throw new Error('manifest ' + reference + ' -> ' + r.status)
        const ct = (r.headers['content-type'] || '').toLowerCase()
        const text = await r.body.text()
        return { type: ct, body: text, digest: r.headers['docker-content-digest'] }
    }

    function pickPlatform(index, want) {
        const j = JSON.parse(index)
        if (!j.manifests || !Array.isArray(j.manifests)) return null
        const wantArch = want.arch || 'amd64'
        const wantOs   = want.os || 'linux'
        return j.manifests.find((m) => m.platform
            && m.platform.architecture === wantArch
            && m.platform.os === wantOs)
            || j.manifests.find((m) => m.platform && m.platform.architecture === wantArch)
    }

    async function getBlobBytes(registry, repository, digest, onProgress) {
        const url = 'https://' + registry + '/v2/' + repository + '/blobs/' + digest
        const r = await getWithAuth(url, repository)
        if (r.status !== 200) throw new Error('blob ' + digest + ' -> ' + r.status)
        const ab = await r.body.arrayBuffer()
        if (onProgress) onProgress(ab.byteLength)
        return new Uint8Array(ab)
    }

    // ---- USTAR writer ----------------------------------------------------
    // Minimal write-only USTAR archive builder. We only need plain files +
    // directory-implied paths (no symlinks/hardlinks/sparse), which fits in
    // the basic USTAR record format.

    const BLOCK = 512
    function octal(n, w) {
        const s = n.toString(8)
        return '0'.repeat(Math.max(0, w - 1 - s.length)) + s + ' '
    }
    function pad(arr, off, len, str) {
        for (let i = 0; i < len && i < str.length; i++) arr[off + i] = str.charCodeAt(i)
    }
    function tarHeader(name, size, mode = 0o644) {
        const buf = new Uint8Array(BLOCK)
        pad(buf, 0, 100, name)
        pad(buf, 100, 8, octal(mode, 8))
        pad(buf, 108, 8, octal(0, 8))                  // uid
        pad(buf, 116, 8, octal(0, 8))                  // gid
        pad(buf, 124, 12, octal(size, 12))             // size
        pad(buf, 136, 12, octal(Math.floor(Date.now()/1000), 12))   // mtime
        pad(buf, 148, 8, '        ')                   // checksum placeholder
        buf[156] = 0x30                                // type = '0' (regular file)
        pad(buf, 257, 6, 'ustar\0')
        pad(buf, 263, 2, '00')
        let sum = 0
        for (let i = 0; i < BLOCK; i++) sum += buf[i]
        pad(buf, 148, 8, octal(sum, 8))
        return buf
    }
    function tarFile(name, bytes, mode) {
        const out = []
        out.push(tarHeader(name, bytes.length, mode))
        out.push(bytes)
        const rem = (BLOCK - (bytes.length % BLOCK)) % BLOCK
        if (rem) out.push(new Uint8Array(rem))
        return out
    }
    function concat(parts) {
        const total = parts.reduce((n, p) => n + p.length, 0)
        const out = new Uint8Array(total)
        let off = 0
        for (const p of parts) { out.set(p, off); off += p.length }
        return out
    }

    // ---- pullImage -------------------------------------------------------

    async function pullImage(ref, opts = {}) {
        const onLog = opts.onLog || (() => {})
        const platform = opts.platform || { os: 'linux', arch: 'amd64' }
        const { registry, repository, tag, digest } = parseRef(ref)
        const reference = digest || tag
        onLog('resolving ' + ref + ' -> ' + registry + '/' + repository + ':' + reference)

        // Step 1: manifest. May be a manifest list -> follow.
        let m = await getManifest(registry, repository, reference)
        let isList = m.type.includes('manifest.list') || m.type.includes('image.index')
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

        // Step 3: layer blobs. Layers stay GZIPPED (`layer.tar.gz`); docker
        // save normally produces uncompressed layer.tar, but buildah's
        // docker-archive reader handles gzipped layers too via skopeo.
        const layerEntries = []
        for (let i = 0; i < mj.layers.length; i++) {
            const l = mj.layers[i]
            onLog('fetch layer ' + (i + 1) + '/' + mj.layers.length + ' ' + l.digest + ' (' + Math.round(l.size / 1024) + ' KiB)')
            const bytes = await getBlobBytes(registry, repository, l.digest)
            // docker-archive layer dir name = layer digest minus "sha256:"
            const layerDir = l.digest.replace(/^sha256:/, '')
            const layerFilename = 'layer.tar'   // skopeo handles either compressed or not
            layerEntries.push({ dir: layerDir, file: layerFilename, bytes })
        }

        // Step 4: assemble docker-archive tar.
        const parts = []
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
        const repositoriesJson = JSON.stringify({
            [registry + '/' + repository]: {
                [tag]: layerEntries.length ? layerEntries[layerEntries.length - 1].dir : '',
            },
        })
        parts.push(...tarFile('repositories', new TextEncoder().encode(repositoriesJson)))
        // tar EOF: two empty 512-byte blocks
        parts.push(new Uint8Array(BLOCK * 2))

        const archive = concat(parts)
        onLog('docker-archive ready: ' + archive.length + ' bytes')
        return archive
    }

    // ---- Dockerfile FROM extractor ---------------------------------------

    function dockerfileFromRefs(text) {
        // Naive but sufficient for v1: each non-comment FROM ref, dedup, ignore `--platform`.
        const out = []
        const seen = new Set()
        for (let line of text.split('\n')) {
            line = line.replace(/^\s+|\s+$/g, '')
            if (!line || line.startsWith('#')) continue
            const m = line.match(/^FROM\s+(?:--\S+\s+)*(\S+)/i)
            if (m) {
                const ref = m[1]
                if (ref.toLowerCase() === 'scratch') continue
                if (!seen.has(ref)) { seen.add(ref); out.push(ref) }
            }
        }
        return out
    }

    if (typeof globalThis !== 'undefined') {
        globalThis.WebvpnRegistry = { pullImage, parseRef, dockerfileFromRefs }
    }
})()
