# @fkn/container

Run a Docker image in a browser tab and make HTTP requests to it.

```ts
import { createContainer } from '@fkn/container'
import image from './api/Dockerfile?container'

const api = createContainer({ image, ports: [8080] })

const response = await api.fetch('/users/42')
console.log(response.status, await response.json())
```

The Vite plugin builds `api/Dockerfile` into a WebAssembly artifact on your
machine whenever it changes. The browser downloads a finished image and starts
it; nothing is built in the tab. `api.fetch` is a real `fetch`, answered by a
real HTTP server inside a real Linux guest.

Live demo and architecture notes: <https://container.fkn.app>

## What is actually running

[container2wasm](https://github.com/container2wasm/container2wasm) converts an
OCI image into a WebAssembly module: an emulated CPU, a Linux kernel, and your
image's root filesystem, snapshotted just after boot so it starts from a warm
state rather than booting from scratch.

That guest has no network. This package gives it one:

```
 ┌── browser tab ────────────────────────────────────────────────────────────┐
 │                                                                           │
 │  worker: guest              worker: netstack           main thread        │
 │  ┌──────────────┐  ethernet ┌────────────────────┐                        │
 │  │ TinyEMU +    │ ══frames═▶│ gVisor stack        │   HttpClient          │
 │  │ Linux +      │           │  DHCP / ARP / DNS   │◀──published ports     │
 │  │ your image   │           │  TCP + UDP forward ─┼──▶ @fkn/lib ─▶ internet│
 │  └──────────────┘           └────────────────────┘                        │
 └───────────────────────────────────────────────────────────────────────────┘
```

Two directions come out of that:

- **Inbound.** Each published port gets an in-process loopback listener. Your
  `fetch` opens a socket on it, the netstack dials the guest's own DHCP lease,
  and your service sees an ordinary TCP connection. Nothing traverses the
  browser's network stack, so there is no CORS, no preflight, and no server.
- **Outbound.** The guest gets working DNS, TCP and UDP through
  [`@fkn/lib`](https://www.npmjs.com/package/@fkn/lib), so `apk add`, `curl`,
  and anything else that expects a network works.

## Install

```sh
npm install @fkn/container
```

You also need **Docker** on the machine that runs the build. Nothing extra:
the plugin builds the pinned container2wasm converter in a Go container the
first time it needs it and caches the result.

## Vite

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { containers } from '@fkn/container/vite'

export default defineConfig({
  plugins: [containers()],
})
```

Then import any Dockerfile with the `?container` query:

```ts
import image from './api/Dockerfile?container'
import worker from './worker/Dockerfile?container&arch=riscv64&memory=256'
```

The import resolves to a URL string. In dev the artifact is served from the
plugin's cache; in a build it is emitted as a hashed asset.

The plugin also:

- sets `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` on the
  dev and preview servers, because the runtime needs `SharedArrayBuffer`;
- maps the Node built-ins the transport is published against to their browser
  implementations;
- rebuilds an image when its Dockerfile or any `COPY`/`ADD` source changes, and
  reloads the page.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `arch` | `'amd64'` | `amd64` or `riscv64`. See [architecture](#architecture). |
| `memoryMB` | `128` | Guest RAM. |
| `cacheDir` | `node_modules/.cache/fkn-container` | Where converted images live. |
| `builder` | `'docker'` | Container CLI to shell out to. |
| `c2wPath` | built on demand | An existing container2wasm binary. |
| `crossOriginIsolation` | `true` | Set the COOP/COEP headers in dev and preview. |
| `images` | `{}` | Named images built even if nothing imports them. |

Per-import overrides go in the query: `?container&arch=riscv64&memory=64&target=stage`.

## Without Vite

```sh
npx fkn-container build ./api/Dockerfile --out public/api.wasm --arch riscv64
```

Then serve `public/api.wasm` as `application/wasm` and pass its URL:

```ts
const api = createContainer({ image: '/api.wasm', ports: [8080] })
```

Your server has to send the isolation headers itself:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`assertCrossOriginIsolated()` turns a missing header into a clear error instead
of a confusing one further down.

## Runtime API

### `createContainer(options): Container`

Returns immediately. The workers start in the background.

| Option | Default | Meaning |
| --- | --- | --- |
| `image` | required | URL or bytes of the converted image. |
| `ports` | `[]` | Guest TCP ports to publish. |
| `network` | `true` | Set `false` for a container with no network at all. |
| `netstackImage` | bundled | Override the network stack module. |
| `onLog` | | Console output, as `Uint8Array` chunks. |
| `onStatus` | | Startup progress: `fetching`, `compiled`, `running`, `serving`. |
| `startupGraceMs` | `90_000` | How long `fetch` retries while the guest starts. |
| `connectTimeoutMs` | `10_000` | Per-connection timeout. |
| `responseTimeoutMs` | `30_000` | Per-response timeout. |
| `columns`, `rows` | `80`, `24` | Terminal geometry reported to the guest. |

### `container.fetch(input, init?): Promise<Response>`

Same shape as `fetch`. A path resolves against the first published port; an
absolute URL is matched by its port against the published set, so
`http://localhost:8080/x` reaches guest port 8080.

The response body is streamed, not buffered, so a large response does not have
to fit in memory twice.

**You do not need to wait for readiness.** While the guest is still starting,
connection failures are retried until `startupGraceMs` elapses. Call `fetch`
straight after `createContainer` and it resolves as soon as the service answers.

### `container.ready: Promise<void>`

Resolves once the guest is running and every published port is bound. Rejects
if startup failed. Waiting on it is optional; `fetch` awaits it internally.

### Other members

```ts
container.ports              // [{ guestPort, host, port, origin }]
container.origin(8080)       // 'http://127.0.0.1:39095'
container.logs()             // ReadableStream<Uint8Array> of guest console output
container.onLog(fn)          // returns an unsubscribe function
container.write('ls\n')      // write to the guest console, as if typed
container.resize(120, 40)    // report a new terminal size
await container.stop()       // terminate the workers and close every socket
```

### `preloadContainer(url)`

Downloads and compiles an image ahead of time so a later `createContainer`
starts from a warm HTTP and code cache. Call it on hover over the button that
will start the container.

## Architecture

`arch` picks which emulator container2wasm builds around, and the difference is
large:

| | `amd64` | `riscv64` |
| --- | --- | --- |
| Emulator | Bochs | TinyEMU |
| Alpine demo image | 109 MB | 54 MB |
| Same, brotli | 40 MB | 16 MB |
| Base image needs | any | a `linux/riscv64` variant |
| `RUN` steps need | nothing | binfmt handlers for riscv64 |

`amd64` is the default because it works with any image on any build host.
Prefer `riscv64` when your base image publishes a riscv64 variant: the artifact
is half the size and the emulator is faster.

If a riscv64 build fails on a `RUN` step, register the handlers once:

```sh
docker run --privileged --rm tonistiigi/binfmt --install riscv64
```

An image whose Dockerfile only uses `FROM`, `COPY`, `EXPOSE` and `CMD` needs no
handlers at all, because nothing is executed at build time.

## Speed

What the numbers depend on, roughly in order:

1. **Transfer size.** Serve the artifact with `Content-Encoding: br`. A 54 MB
   riscv64 image is 16 MB over the wire; the same image gzipped is 26 MB.
2. **Streaming compilation.** Serve it as `application/wasm` so the runtime can
   use `WebAssembly.instantiateStreaming`. Compilation then overlaps the
   download, and Chrome populates its WebAssembly code cache, which is what
   makes a repeat visit start almost instantly. The runtime warns in the console
   if the content type forces it onto the slow path.
3. **Immutable caching.** The plugin's file names carry the image digest, so
   `Cache-Control: public, max-age=31536000, immutable` is safe and correct.
4. **Your service.** Once the guest is up, per-request latency is dominated by
   what the container does. A service that forks a shell per connection costs
   roughly 170 ms per request under emulation; a persistent process that accepts
   in a loop is far cheaper. The runtime keeps connections alive and pools them
   when the server allows it.
5. **`preloadContainer`.** Moving the download before the click removes it from
   the perceived startup time.

Measured on the demo image, riscv64, localhost:

| | |
| --- | --- |
| Download plus streaming compile | 3.0 s |
| First HTTP response after the call | 4.3 s |
| Steady-state request latency | 166 to 186 ms, median 170 ms |
| Throughput of a download run inside the guest | around 197 KB/s |

The guest itself copies memory at about 1.2 MB/s under emulation, which is the
ceiling everything else sits under.

## Requirements

- A cross-origin isolated page (`SharedArrayBuffer` and `Atomics.wait`).
- Module workers.
- Docker, on the build machine only.

## Repository layout

| Path | What it is |
| --- | --- |
| `src/lib/` | The published runtime. |
| `src/vite/` | The Vite plugin and the `fkn-container` CLI. |
| `src/proxy/` | The Go network stack, compiled to `wasip1/wasm`. |
| `index.html`, `src/homepage.ts` | The live demo at container.fkn.app. |
| `dockerfile/`, `src/playground.ts` | The in-browser Dockerfile builder. |
| `playground/`, `src/main.ts` | The runtime page the builder launches. |

The in-browser builder is a demo of what the network path makes possible, not the
recommended way to ship an image. It boots an amd64 builder guest, so it runs on
Bochs and is minutes slower than the prebuilt riscv64 artifacts the plugin
produces. Use the plugin for anything real.

### Building this repository

```sh
npm ci
npm run make-docker      # Go network stack -> dist/c2w-webvpn-proxy.wasm
npm run build-presets    # the demo images -> public/presets/
npm run dev-web          # http://localhost:1234
```

```sh
npm run build:lib        # the publishable package -> lib/
npm run typecheck
```

The generated `.wasm` files are gitignored and must be built locally. The
network stack lives in `src/proxy/`; see its comments for the egress ABI, which
is shared with `src/lib/workers/netstack.worker.ts` and must stay in sync.

### Production hosting

`container.fkn.app` is a Cloudflare Pages project built with
`npm run build:pages`. Converted images are too large for the Pages output, so
they live in an R2 bucket served by a read-only Pages Function at
`/wasm-assets/*`, keeping every request same-origin. Each URL carries its own
content digest, so rebuilding one artifact does not invalidate the others.

Publish one target per run:

```sh
npm run publish-wasm-assets -- presets     # or proxy, playground, all
git add wasm-assets.json preset-assets.json
```

**Publish before deploying, and mind the encoding.** The objects are stored
pre-compressed and the Function echoes the stored `Content-Encoding`, so an
object written as brotli is unreadable through a Function that still hardcodes
gzip. Since the keys carry content digests, a newly published artifact is
unreferenced until the site that names it deploys, and both go live in the same
Pages deployment. So:

1. Publish the artifacts. The route check will fail while the deployed Function
   is older than the new encoding; rerun with `ALLOW_PENDING_ASSET_ROUTE=1` to
   accept the R2-side verification.
2. Deploy the site and the Function together.
3. Rerun the publication without the flag to verify the public route.

Do not try to read the encoding off a `HEAD`: Cloudflare negotiates
`Content-Encoding` at the edge and returns whatever the client asked for, so it
tells you nothing about how the object was stored. Only decoding the body does.

## License

MIT
