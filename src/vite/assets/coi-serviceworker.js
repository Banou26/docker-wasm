// Cross-origin isolation without server configuration.
//
// The runtime needs SharedArrayBuffer, which needs the document to be
// cross-origin isolated, which normally means setting COOP and COEP response
// headers. Plenty of hosts do not let you set headers at all: GitHub Pages,
// most static CDNs, anywhere the app is dropped into someone else's stack.
//
// Those headers are also honoured when a service worker supplies them, so this
// worker adds them to every response it serves and the page reloads once to
// come back isolated. Emitted and registered by the Vite plugin; see the
// `crossOriginIsolation` option.

/* eslint-env serviceworker */

const COEP = '__FKN_CONTAINER_COEP__'

if (typeof self !== 'undefined' && typeof window === 'undefined') {
  self.addEventListener('install', () => self.skipWaiting())
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

  self.addEventListener('fetch', (event) => {
    const request = event.request
    // Range requests replayed from the cache must be left alone or the browser
    // errors before the response is ever read.
    if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return

    event.respondWith(
      fetch(request)
        .then((response) => {
          // Opaque responses have no readable headers and cannot be rebuilt.
          // Under `credentialless` they are allowed through as they are.
          if (response.status === 0) return response

          const headers = new Headers(response.headers)
          headers.set('Cross-Origin-Embedder-Policy', COEP)
          headers.set('Cross-Origin-Opener-Policy', 'same-origin')
          headers.set('Cross-Origin-Resource-Policy', 'cross-origin')

          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          })
        })
        .catch((error) => {
          console.error('[fkn-container] isolation worker could not fetch', request.url, error)
          return Response.error()
        }),
    )
  })
} else if (typeof window !== 'undefined') {
  // Page side: register, then reload once so the document is re-fetched through
  // the worker and comes back isolated.
  //
  // `document.currentScript` is only readable while this script is executing,
  // so the URL is captured now rather than inside the promise, where it is null.
  const workerUrl = document.currentScript && document.currentScript.src
  const reloadedKey = 'fkn-container-coi-reloaded'

  const reloadOnce = () => {
    // Guards a loop when isolation is unreachable at all: not a secure context,
    // or a browser that does not understand this COEP value.
    if (sessionStorage.getItem(reloadedKey)) {
      console.warn(
        '[fkn-container] the isolation worker is registered but this page is still not ' +
        'cross-origin isolated. This browser may not support the "' + COEP + '" COEP value.',
      )
      return
    }
    sessionStorage.setItem(reloadedKey, '1')
    window.location.reload()
  }

  if (window.crossOriginIsolated) {
    sessionStorage.removeItem(reloadedKey)
  } else if (!window.isSecureContext) {
    console.warn(
      '[fkn-container] cross-origin isolation needs a secure context. Serve this page over ' +
      'HTTPS, or from localhost.',
    )
  } else if (navigator.serviceWorker && workerUrl) {
    navigator.serviceWorker
      .register(workerUrl, { scope: './' })
      .then((registration) => {
        // The first visit installs the worker but is not yet controlled by it,
        // so the document still lacks the headers until it is fetched again.
        registration.addEventListener('updatefound', reloadOnce)
        if (registration.active && !navigator.serviceWorker.controller) reloadOnce()
      })
      .catch((error) => {
        console.error('[fkn-container] could not register the isolation worker', error)
      })
  }
}
