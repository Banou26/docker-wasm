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
│         │ at shell prompt, fetches the generated build script from :9090      │
│         │   script fetches each /img/<ref> and imports its docker-archive     │
│         │   buildah bud --isolation chroot --pull=never -t userimg .          │
│         │   FROM/EXPOSE/CMD: reuse Buildah's final build container             │
│         │   otherwise: create a container from userimg                         │
│         │   run shell or image command + map virtual TCP when requested        │
│         ▼                                                                     │
│  netstack proxy serves scripts and tar bytes at gateway:9090 via two         │
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

The build script patches container2wasm v0.8.4 before conversion. The resulting
OCI spec grants `CAP_SYS_ADMIN` and mounts a 256 MiB tmpfs at
`/var/lib/containers/storage`, giving Buildah a native overlay graphroot without
placing another overlay on the guest's overlay-backed root.

`playground.wasm` is the only large guest artifact that ships per deployment
(about 158 MiB raw or 57 MiB gzip: alpine + buildah + cdrkit + Bochs + a Linux
kernel). Its versioned URL remains cached until that artifact changes; a proxy
rebuild does not invalidate it. Dockerfiles cost zero on the build side.

## Run

```sh
npm run dev-web
```

Open <http://localhost:1234/playground/>. Drop or paste a Dockerfile, choose a
launch, and click the launch button. The JS side starts pulling FROM images
immediately. Once Bochs boots, the auto-paste downloads the bytes from the
netstack proxy's gateway:9090 HTTP server and runs the generated build script.
The script imports image archives with `buildah pull docker-archive:` and removes
the temporary tar after import. It then runs the user's Dockerfile. Shell mode
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
* ✅ **Native overlay layers**: Buildah uses a dedicated tmpfs graphroot with
  native overlay diff support. A browser validation committed a filesystem
  mutation from `RUN printf cow-layer > /cow-layer`, started the resulting
  image, and returned HTTP 200.
* ✅ **Interactive shell**: both Ghostty terminal buffers are rendered and the
  final container prompt accepts input.
* ✅ **Virtual HTTP service**: `publish=tcp:8080` opens an FKN loopback listener,
  `@fkn/lib/http` connects through the in-process data plane, gVisor dials the
  guest DHCP lease, and the browser receives the image's JSON response.
* ✅ **Responsive UI**: the workbench and runtime are validated at desktop and
  mobile widths.

## Known sharp edges

* Bochs emulation is slow. In a warm-cache validation on `banou-pc`, the default
  metadata-only HTTP image finished building at 50.0 seconds, reached service
  readiness at 70.0 seconds, and returned its first response in 66 ms. The prior
  VFS checkpoint reached service readiness at 79.2 seconds. This
  compact `FROM`/`EXPOSE`/`CMD` path retains Buildah's final working container
  instead of creating another container from the completed image, then removes
  stale intermediate containers after launch. Other Dockerfiles keep the normal
  container creation path.
* Buildah cannot place native overlay directly on the guest's overlay-backed
  root. The patched OCI tmpfs is therefore required. A persistent guest layer
  cache remains the next storage-level optimization.
* The overlay graphroot is capped at 256 MiB inside the 512 MiB guest. Larger
  imported images or build layers can exhaust that storage.
* Generated build scripts are served through the local gateway artifact bridge.
  Sending the full script through the interactive PTY can stop at its input
  limit before the final command arrives.
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
