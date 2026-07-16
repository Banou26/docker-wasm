const objectRules = [
  {
    pattern: /^(?:playground\/playground|c2w-webvpn-proxy|presets\/(?:shell|http))\.[0-9a-f]{64}\.wasm\.js$/,
    contentType: 'application/wasm',
  },
]

const responseHeaders = (object, contentType) => {
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('Content-Type', contentType)
  headers.set('Content-Encoding', 'gzip')
  headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  headers.set('ETag', object.httpEtag)
  headers.set('X-Content-Type-Options', 'nosniff')
  return headers
}

export async function onRequest(context) {
  const { request, env, params } = context
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { Allow: 'GET, HEAD' },
    })
  }

  const key = Array.isArray(params.path) ? params.path.join('/') : params.path
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
    cachedHeaders.set('Content-Encoding', 'gzip')
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
