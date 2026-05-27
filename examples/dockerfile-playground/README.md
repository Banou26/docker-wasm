# dockerfile-playground

A website where you drop a Dockerfile and **everything happens in your browser**.
The build runs inside an alpine+buildah image that's been c2w-converted to wasm
once and is served as a static asset; the user's Dockerfile rides in via the
URL hash; **the FROM image is pulled live from Docker Hub through the browser**.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  /playground/ (drop UI)                                                       │
│         │ base64-encode Dockerfile -> URL hash, navigate                      │
│         ▼                                                                     │
│  /?net=webvpn&wasm-url=/playground/playground.wasm#dockerfile=<b64>          │
│         │                                                                     │
│         │   (in parallel, JS parses FROM refs from the hash and pulls each    │
│         │    image via @fkn/lib's serverProxyFetch -> /proxy shim -> Docker   │
│         │    Hub, assembling a docker-archive tar in memory)                  │
│         │                                                                     │
│         ▼                                                                     │
│  c2w runtime → boots playground.wasm (alpine + buildah inside Bochs)         │
│         │ at shell prompt, auto-types:                                        │
│         │   wget http://192.168.127.1:9090/img/<ref> -O /tmp/<ref>.tar       │
│         │   buildah pull docker-archive:/tmp/<ref>.tar                        │
│         │   buildah bud --pull=never -t userimg .                             │
│         │   ctr=$(buildah from userimg) && buildah run --tty "$ctr" /bin/sh  │
│         ▼                                                                     │
│  netstack proxy serves the pulled tar bytes at gateway:9090 via two          │
│  wasmimports (webvpn_image_size + webvpn_image_chunk) into a JS-side cache.  │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Nothing leaves the browser** except the actual Docker Hub HTTPS request,
routed through @fkn/lib's `serverProxyFetch` chain (which sends an HTTP request
to the page's own `/proxy` endpoint — a thin, fkn-proxy-compatible CORS
pass-through, structurally identical to running fkn/proxy locally).

## Prereqs

- A normal dev box once, to build `playground.wasm` (Docker + Go + c2w).
- For runtime: `~/dev/fkn/webvpn` (Rust WebTransport server) + `~/dev/fkn/web`
  (vite dev) running locally; see `../alpine-curl/README.md`.
- The alpine-curl runtime must be built first — run `scripts/build-image.sh`
  once. It populates `public/` with `out.wasm`, `c2w-webvpn-proxy.wasm`, the
  upstream c2w worker assets, then runs the Vite build into `build/`.

## Build the playground wasm (one-time, ≈ 5 min)

```sh
cd examples/dockerfile-playground
docker build -t c2w-playground-builder .
c2w --build-arg VM_MEMORY_SIZE_MB=512 c2w-playground-builder \
    ../../public/playground/playground.wasm

# Re-stage into the served build/ (Vite copies public/ -> build/ on build):
( cd ../.. && npm run build )
```

`VM_MEMORY_SIZE_MB=512` is required — buildah's chroot-isolation RUN spawns a
subprocess that OOMs at the default 128 MB.

`playground.wasm` is the only thing that ships per-deployment (≈ 160 MB:
alpine + buildah + cdrkit + Bochs + a Linux kernel). The user downloads it
once; their Dockerfiles cost zero on the build side.

## Run

```sh
# the @fkn/lib iframe needs to know where to send proxyFetches:
CERT_HASH=$(curl -s http://localhost:4434/cert-hash)
cd ~/dev/fkn/web && \
    VITE_WEBVPN_ORIGIN="https://localhost:4433" \
    VITE_WEBVPN_CERT_HASH="$CERT_HASH" \
    VITE_PROXY_ORIGIN="http://127.0.0.1:8080/proxy" \
    npx vite --port 1234 --host 127.0.0.1 &

# the playground itself:
node scripts/serve.cjs    # static + /proxy (fkn-proxy-compatible CORS shim), COOP/COEP, port 8080
```

Open <http://127.0.0.1:8080/playground/>. Drop or paste a Dockerfile. Click
"Open in browser". The JS-side starts pulling FROM images immediately; once
Bochs boots, the auto-paste wget's the bytes from the netstack proxy's
gateway:9090 HTTP server and `buildah pull docker-archive:` them in. Then it
runs the user's Dockerfile and drops into `buildah run --tty` on the result.

## What works today

* ✅ **Drop UI → URL hash → in-browser build → live container shell.**
* ✅ **Live Docker Hub pull**: JS-side OCI Registry V2 client (registry.js)
  authenticates anonymously, fetches manifest list + platform manifest +
  config + layers, assembles a docker-archive tar in memory.
* ✅ **No pre-baked images**: any Dockerfile whose FROM resolves to a public
  registry image works.
* ✅ **DNS via DoH**: gateway:53 queries are POSTed to Cloudflare DoH via
  serverProxyFetch — buildah's network from inside Bochs never has to wait on
  UDP through @webvpn.
* ✅ **RUN steps with network**: the @webvpn netstack path still serves
  arbitrary TCP/UDP for `RUN apk add …` etc.

## Known sharp edges

* Bochs emulation is slow — the build is on the order of minutes for a simple
  `FROM alpine; CMD …`. Most of the time is spent copying the layer through
  vfs storage; future work: a smarter storage driver or larger guest RAM.
* The base64 hash payload caps at the URL length the browser allows (a few
  kilobytes in practice). Larger Dockerfiles or contexts would need a
  different transport.

## Why no backend

Earlier iterations had a Node backend running `docker build` + `c2w` on every
drop. That defeated the point — the whole reason we built a netstack +
bridged @webvpn was so build/run can happen client-side. The build server is
gone; what's left is a static file server + a tiny fkn-proxy-compatible CORS
shim at `/proxy` so the browser can hit registries that don't send
`Access-Control-Allow-Origin`.
