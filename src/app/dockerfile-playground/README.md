# dockerfile-playground

A website where you drop a Dockerfile and **everything happens in your browser**.
The user's Dockerfile rides in via the URL hash. Exact built-in examples boot a
dedicated container2wasm image directly. Edited Dockerfiles boot the separate
Alpine plus Buildah guest and pull their FROM images live from Docker Hub.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  / (Dockerfile launcher)                                                      │
│         │ base64-encode Dockerfile -> URL hash, navigate                      │
│         ▼                                                                     │
│  /playground/?net=webvpn&wasm-url=<versioned-url>#dockerfile=<b64>           │
│  optional service params: publish=tcp:8080&run=default                       │
│         │                                                                     │
│         ├── exact Shell or HTTP source                                        │
│         │      boot presets/<mode>.wasm and run the embedded image directly   │
│         │                                                                     │
│         └── any edited source                                                  │
│                boot playground.wasm (Alpine + Buildah inside Bochs)           │
│                pull FROM archives through gateway:9090                        │
│                run buildah bud, then start the shell or image command          │
│                                                                               │
│  Both paths use the c2w network worker and FKN-backed gVisor netstack.        │
│  Service mode maps virtual TCP into the selected guest.                       │
└──────────────────────────────────────────────────────────────────────────────┘
```

Build state stays in the browser. Registry requests and guest TCP/UDP flows are
carried by `@fkn/lib`. Service requests pair with an FKN loopback listener in
the shared in-process data plane, then enter the guest through gVisor.

## Prereqs

- A normal dev box once, to build `playground.wasm` (Docker + Go + c2w).
- The proxy and playground WASM artifacts must exist under `public/`. They are
  generated locally and gitignored.
- Docker and Go build `public/presets/shell.wasm` and
  `public/presets/http.wasm`. The build script compiles its own pinned c2w CLI.
- Wrangler is required to publish production artifacts to R2.
- The hosted FKN API is used by default.

## Build the playground wasm (one-time, ≈ 5 min)

```sh
./scripts/build-playground.sh

# Re-stage into the served build/ (Vite copies public/ -> build/ on build):
npm run vite-build
```

`VM_MEMORY_SIZE_MB=512` is required: buildah's chroot-isolation RUN spawns a
subprocess that OOMs at the default 128 MB.

The build script patches container2wasm v0.8.4 before conversion. The resulting
OCI spec grants `CAP_SYS_ADMIN` and mounts a 256 MiB tmpfs at
`/var/lib/containers/storage`, giving Buildah a native overlay graphroot without
placing another overlay on the guest's overlay-backed root.

`playground.wasm` is about 158 MiB raw or 57 MiB gzip (alpine + buildah +
cdrkit + Bochs + a Linux kernel). Production stores the encoded artifact in R2
because it exceeds the Cloudflare Pages file limit. Its versioned URL remains
cached until that artifact changes; a proxy rebuild does not invalidate it.
Dockerfiles cost zero on the build side.

Publish the generated production artifact with
`npm run publish-wasm-assets -- playground`, then commit the refreshed
`wasm-assets.json` before pushing the Pages application.

Build and verify the exact-match preset runtimes separately:

```sh
npm run build-presets
npm run verify-presets
npm run publish-wasm-assets -- presets
```

The build uses container2wasm v0.8.4 at commit
`6ed3d98882a2b22eafc1334f574c364a5b2b8c47`. It produces a 113,195,366-byte
Shell runtime and a 108,941,914-byte HTTP runtime. Gzip reduces them to
42,382,427 and 40,359,206 bytes. Verification requires the current canonical
Dockerfile digests, `linux/amd64`, valid c2w module exports, and the expected
WASI imports before publication accepts either artifact.

## Run

```sh
npm run dev-web
```

Open <http://localhost:1234/>. Drop or paste a Dockerfile, choose a launch, and
click the launch button. Intent on an exact example starts warming its dedicated
runtime. Exact examples boot their image directly. Edited Dockerfiles boot the
builder, download the generated script from the gateway:9090 artifact bridge,
then keep the live FROM pull and Buildah path. Shell mode opens `/bin/sh`. HTTP
service mode starts the image command and requests guest port 8080 through an
in-process FKN virtual TCP port.

## What works today

* ✅ **Drop UI → URL hash → in-browser build → live container shell.**
* ✅ **Live Docker Hub pull**: JS-side OCI Registry V2 client (registry.js)
  authenticates anonymously, fetches manifest list + platform manifest +
  config + layers, assembles a docker-archive tar in memory.
* ✅ **Exact built-in images**: canonical Shell and HTTP examples use separate
  digest-keyed c2w runtimes, with no builder guest, registry request, or Buildah.
* ✅ **Arbitrary Dockerfiles**: any edited Dockerfile whose FROM resolves to a
  public registry image keeps the full live build path.
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
   guest DHCP lease, and the browser receives the image's JSON response. The
   image keeps one `nc -lk` listener alive, consumes each request's headers, and
   writes startup plus per-request lines to the guest log pane. Each settled
   browser request destroys its client socket so the 32 active ingress slots are
   reusable. Manual requests retry short ingress setup delays.
* ✅ **Responsive UI**: the workbench and runtime are validated at desktop and
  mobile widths.

## Known sharp edges

* Bochs emulation remains the startup floor. In a controlled local browser run,
  the dedicated Shell runtime reached its interactive prompt at 7.13 seconds.
   The dedicated HTTP runtime returned its first JSON response at 10.22 seconds,
   including 3.13 seconds to establish the virtual listener. The same HTTP
  source with one comment used the builder, completed its image at 50.08
  seconds, reached service readiness at 71.09 seconds, and returned at 71.16
   seconds. Compact custom `FROM`/`EXPOSE`/`CMD` builds retain Buildah's final
   working container; other custom Dockerfiles use normal container creation.
   A sequential stress run returned HTTP 200 for all 100 manual requests with
   no visible retry.
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
