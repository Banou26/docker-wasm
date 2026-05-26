# dockerfile-playground

A website where you drop a Dockerfile and **everything happens in your browser**
— no backend, no build server. The build runs inside an alpine+buildah image
that's been c2w-converted to wasm once and is served as a static asset; the
user's Dockerfile rides in via the URL hash.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  /playground/ (drop UI)                                                   │
│         │ base64-encode Dockerfile -> URL hash, navigate                  │
│         ▼                                                                 │
│  /?net=webvpn&wasm-url=/playground/playground.wasm#dockerfile=<b64>      │
│         │                                                                 │
│         ▼                                                                 │
│  c2w runtime  → boots playground.wasm (alpine + buildah inside Bochs)    │
│         │ at shell prompt, auto-types:                                    │
│         │     write storage.conf, decode Dockerfile from hash,            │
│         │     buildah bud, buildah run --tty                              │
│         ▼                                                                 │
│  c2w-webvpn netstack proxy → @webvpn → registry pulls + RUN-step network │
└──────────────────────────────────────────────────────────────────────────┘
```

**Nothing leaves the browser** except the actual network traffic the user's
build needs (via @webvpn). No POST of the Dockerfile to a server; no
server-side build queue.

## Prereqs

Same setup as `examples/alpine-curl/`:

- A normal dev box once, to build `playground.wasm` (Docker + Go + c2w).
- For runtime: `~/dev/fkn/webvpn` (Rust WebTransport server) + `~/dev/fkn/web`
  (vite dev) running locally; see `../alpine-curl/README.md`.
- The alpine-curl htdocs assets must exist (`examples/alpine-curl/htdocs/`) —
  the playground reuses them.

## Build the playground wasm (one-time, ≈ 5 min)

```sh
cd examples/dockerfile-playground/playground-image
docker build -t c2w-playground-builder .
c2w c2w-playground-builder ../web/playground.wasm
```

`playground.wasm` is the only thing that ships per-deployment. It's ~150 MB
(alpine + buildah + busybox + a bochs emulator + a Linux kernel). The user
downloads it once; their Dockerfiles cost zero on the build side.

## Run

```sh
cd examples/dockerfile-playground
node serve.cjs                # static, COOP/COEP, port 8080
```

Open <http://127.0.0.1:8080/playground/>. Drop or paste a Dockerfile. Click
"Open in browser". Wait for Bochs to boot, then the build script auto-runs.

## What's verified vs. open

* ✅ **Architecture is wired**: drop UI → URL hash → `?wasm-url=`-driven c2w
  runtime → playground.wasm boots → auto-paste fires the build script →
  buildah runs inside the guest → its TCP/UDP egress flows through this repo's
  netstack → @webvpn → real internet.
* ✅ **Buildah parses the user's Dockerfile**, runs `STEP 1/n: FROM …`, resolves
  the short name via `/etc/containers/registries.conf.d/00-shortnames.conf`,
  and starts pulling.
* ⚠️ **Registry pull reliability is the open issue.** Bochs emulation + our
  netstack + @webvpn round-trips are slow enough that Docker Hub's TLS
  handshake routinely exceeds buildah's 30-s connection timeout. Subsequent
  DNS queries to the gateway DNS forwarder also start timing out under load.
  Either we:
  - pre-pull a small base into `playground.wasm` so first-FROM doesn't need a
    pull, or
  - bump buildah's connect timeout, or
  - improve netstack performance (smarter forwarder reuse, lower per-flow
    overhead).

## Why no backend

Earlier iterations of this had a Node backend running `docker build` + `c2w`
on every drop. That defeated the point of the project — the whole reason we
built a netstack + bridged @webvpn was so build/run can happen client-side. So
the build server is gone; what's left is a static file server + one prebuilt
wasm.
