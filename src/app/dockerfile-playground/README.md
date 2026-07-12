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
│  optional service params: publish=tcp:8080&run=default                       │
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
│         │   shell: buildah run --tty "$ctr" /bin/sh                          │
│         │   service: run image command + map FKN virtual TCP into guest       │
│         ▼                                                                     │
│  netstack proxy serves the pulled tar bytes at gateway:9090 via two          │
│  wasmimports (webvpn_image_size + webvpn_image_chunk) into a JS-side cache.  │
└──────────────────────────────────────────────────────────────────────────────┘
```

Build state stays in the browser. Registry requests and guest TCP/UDP flows are
carried by `@fkn/lib`. Service requests pair with an FKN loopback listener in
the shared in-process data plane, then enter the guest through gVisor.

## Prereqs

- A normal dev box once, to build `playground.wasm` (Docker + Go + c2w).
- The proxy and playground WASM artifacts must exist under `public/`. They are
  generated locally and gitignored.
- The hosted FKN API is used by default.

## Build the playground wasm (one-time, ≈ 5 min)

```sh
./scripts/build-playground.sh

# Re-stage into the served build/ (Vite copies public/ -> build/ on build):
npm run build
```

`VM_MEMORY_SIZE_MB=512` is required: buildah's chroot-isolation RUN spawns a
subprocess that OOMs at the default 128 MB.

`playground.wasm` is the only thing that ships per-deployment (≈ 160 MB:
alpine + buildah + cdrkit + Bochs + a Linux kernel). The user downloads it
once; their Dockerfiles cost zero on the build side.

## Run

```sh
npm run dev-web
```

Open <http://localhost:1234/playground/>. Drop or paste a Dockerfile, choose a
launch, and click the launch button. The JS side starts pulling FROM images
immediately. Once Bochs boots, the auto-paste downloads the bytes from the
netstack proxy's gateway:9090 HTTP server and imports them with
`buildah pull docker-archive:`. It then runs the user's Dockerfile. Shell mode
opens `/bin/sh`. HTTP service mode starts the image command, waits for guest port
8080, and requests the service through an in-process FKN virtual TCP port.

## What works today

* ✅ **Drop UI → URL hash → in-browser build → live container shell.**
* ✅ **Live Docker Hub pull**: JS-side OCI Registry V2 client (registry.js)
  authenticates anonymously, fetches manifest list + platform manifest +
  config + layers, assembles a docker-archive tar in memory.
* ✅ **No pre-baked images**: any Dockerfile whose FROM resolves to a public
  registry image works.
* ✅ **DNS via DoH**: gateway:53 queries are POSTed to Cloudflare DoH via
  serverProxyFetch; buildah's network from inside Bochs never has to wait on
  UDP through @webvpn.
* ✅ **RUN steps with network**: the FKN netstack path serves
  arbitrary TCP/UDP for `RUN apk add …` etc.
* ✅ **Interactive shell**: both Ghostty terminal buffers are rendered and the
  final container prompt accepts input.
* ✅ **Virtual HTTP service**: `publish=tcp:8080` opens an FKN loopback listener,
  `@fkn/lib/http` connects through the in-process data plane, gVisor dials the
  guest DHCP lease, and the browser receives the image's HTML response.
* ✅ **Responsive UI**: the workbench and runtime are validated at desktop and
  mobile widths.

## Known sharp edges

* Bochs emulation is slow; the build is on the order of minutes for a simple
  `FROM alpine; CMD …`. Most of the time is spent copying the layer through
  vfs storage; future work: a smarter storage driver or larger guest RAM.
* The generated launch script must stay chunked across PTY writes. A single
  large paste truncates around the terminal input limit before the here-doc
  delimiter arrives.
* The base64 hash payload caps at the URL length the browser allows (a few
  kilobytes in practice). Larger Dockerfiles or contexts would need a
  different transport.
* Virtual guest routes currently support TCP only and close with the page.

## Why no backend

Earlier iterations had a Node backend running `docker build` + `c2w` on every
drop. That defeated the point: the whole reason we built a netstack +
bridged @webvpn was so build/run can happen client-side. The build server is
gone; what's left is a static file server + a tiny fkn-proxy-compatible CORS
shim at `/proxy` so the browser can hit registries that don't send
`Access-Control-Allow-Origin`.
