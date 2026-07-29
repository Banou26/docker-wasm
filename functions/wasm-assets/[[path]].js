// Read-only bridge from Pages to the R2 bucket holding the converted images.
//
// The artifacts are far past the Pages per-file limit, so they live in R2 and
// are served from here, same-origin, with the digest in the key. Objects are
// stored already compressed and passed through untouched: `encodeBody: 'manual'`
// tells the runtime the body is final, and the stored Content-Encoding is
// echoed rather than assumed, so the bucket can move from gzip to brotli one
// object at a time.

const objectRules = [
  {
    pattern: /^(?:playground\/playground|c2w-webvpn-proxy|presets\/(?:shell|http))\.[0-9a-f]{64}\.wasm\.js$/,
    contentType: 'application/wasm',
  },
]

const contentEncodingOf = (object) => object.httpMetadata?.contentEncoding || 'gzip'

const responseHeaders = (object, contentType) => {
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('Content-Type', contentType)
  headers.set('Content-Encoding', contentEncodingOf(object))
  headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  headers.set('ETag', object.httpEtag)
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Vary', 'Accept-Encoding')
  return headers
}

export async function onRequest (context) {
  const { request, env, params } = context
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { Allow: 'GET, HEAD' },
    })
  }

  const requested = Array.isArray(params.path) ? params.path.join('/') : params.path
  // A leading generation segment only changes the public URL. It exists to
  // sidestep an edge cache holding a response from before this Function could
  // serve the object, and is stripped before the R2 lookup so the stored keys
  // never move.
  const key = typeof requested === 'string' ? requested.replace(/^g[0-9]+\//, '') : requested
  const rule = typeof key === 'string'
    ? objectRules.find(({ pattern }) => pattern.test(key))
    : undefined
  if (!rule) {
    return new Response('Not found', { status: 404 })
  }

  if (request.method === 'HEAD') {
    const object = await env.WASM_ASSETS.head(key)
    if (object === null) return new Response('Not found', { status: 404 })
    return new Response(null, {
      headers: responseHeaders(object, rule.contentType),
      encodeBody: 'manual',
    })
  }

  const cacheUrl = new URL(request.url)
  cacheUrl.search = ''
  const cacheKey = new Request(cacheUrl, { method: 'GET' })
  const cached = await caches.default.match(cacheKey)
  if (cached) {
    const cachedHeaders = new Headers(cached.headers)
    cachedHeaders.set('Content-Type', rule.contentType)
    // The cache entry stores the encoding it was written with, because the
    // colocated cache strips Content-Encoding from what it keeps.
    cachedHeaders.set('Content-Encoding', cachedHeaders.get('X-Stored-Encoding') || 'gzip')
    cachedHeaders.delete('X-Stored-Encoding')
    return new Response(cached.body, {
      status: cached.status,
      statusText: cached.statusText,
      headers: cachedHeaders,
      encodeBody: 'manual',
    })
  }

  const object = await env.WASM_ASSETS.get(key)
  if (object === null) return new Response('Not found', { status: 404 })

  const response = new Response(object.body, {
    headers: responseHeaders(object, rule.contentType),
    encodeBody: 'manual',
  })

  const cacheHeaders = new Headers(response.headers)
  cacheHeaders.set('X-Stored-Encoding', contentEncodingOf(object))
  cacheHeaders.delete('Content-Encoding')
  const cacheResponse = new Response(response.clone().body, {
    status: response.status,
    statusText: response.statusText,
    headers: cacheHeaders,
    encodeBody: 'manual',
  })
  context.waitUntil(caches.default.put(cacheKey, cacheResponse).catch((error) => {
    console.warn('Artifact cache write failed', error)
  }))
  return response
}
