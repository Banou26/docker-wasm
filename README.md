# c2w-webvpn: real TCP/UDP egress for container2wasm, in the browser

Run **any Docker image** in the browser (via [container2wasm](https://github.com/ktock/container2wasm))
with TCP/UDP egress and in-process TCP routes. Guest traffic is carried
through [`@fkn/lib`](https://www.npmjs.com/package/@fkn/lib), the same FKN
transport used by WASM-compiled libtorrent.

This is the "Path B" from the design discussion: instead of intercepting BSD
socket syscalls of a single Emscripten program (which only works for programs
*you* compile), we let container2wasm emulate a full Linux kernel and intercept
at the **virtual NIC**, terminating the guest's IP traffic in an in-browser
gVisor netstack and dialing the real destination over FKN.

## Why this is needed

container2wasm already ships an in-browser network stack (`c2w-net-proxy.wasm`,
built on gVisor + gvisor-tap-vsock). But in the browser its egress is limited to
the **Fetch API**, so the guest can only reach **HTTP/HTTPS** sites that also
permit CORS: no raw TCP, no UDP, no `apt-get`, no DNS-over-UDP, no SSH, no
BitTorrent.

The limitation is *not* the netstack; gVisor terminates arbitrary TCP/UDP just
fine. It's the final hop: upstream dials out with Go's `net.Dial`, which doesn't
exist under `GOOS=wasip1`, so they fall back to `fetch()`. `@fkn/lib` provides
browser-side TCP/UDP sockets, which are exactly the missing hop.

## Architecture

```
 ┌── browser tab ─────────────────────────────────────────────────────────┐
 │                                                                         │
 │  Worker: emulator            Worker: this netstack         Main thread  │
 │  ┌──────────────┐  QEMU      ┌───────────────────────┐                  │
 │  │ TinyEMU /    │  ethernet  │ gVisor netstack        │   @fkn/lib/net   │
 │  │ Bochs + Linux│═══frames══▶│  • DHCP/ARP/DNS gw     │   @fkn/lib/dgram │
 │  │ + your image │            │  • TCP/UDP forwarder ──┼──▶ wasmimport ──▶│──▶ VPN ──▶ internet
 │  └──────────────┘            └───────────────────────┘   (SAB round-trip)│
 │                                                                         │
 └─────────────────────────────────────────────────────────────────────────┘
```

The only thing this project changes vs. stock container2wasm is the forwarder's
**dial**: `net.Dial` → `dialWebvpn` (see `src/proxy/webvpn.go`). Everything else
(emulation, QEMU framing, DHCP, ARP, the gVisor TCP/IP termination) is reused
unchanged.

Virtual TCP runs the same path in reverse. The main thread opens an FKN loopback
listener, and `@fkn/lib/http` dials its virtual port. FKN pairs the streams in
the shared in-process data plane, then the accepted socket crosses the
SharedArrayBuffer ABI and gVisor dials the guest's DHCP lease and requested
port. Routes are scoped to the page lifecycle and allow up to 32 active sockets.

### The egress seam

* `src/proxy/netstack/`: assembles the gVisor stack from gvisor-tap-vsock's
  exported pieces (`tap.NewLinkEndpoint/NewSwitch/NewIPPool`, `dhcp.New`) and
  installs TCP + UDP forwarders that dial via an injected `DialFunc`. A small
  DNS forwarder on the gateway relays the guest's `:53` queries out over UDP
  (the guest's resolver is pointed at the gateway by DHCP). The dial is a
  parameter, not a hard dependency: the wasm build injects FKN sockets, the
  test injects `net.Dial`.
  It also forwards FKN virtual TCP sockets into the guest.
* `src/proxy/main.go` - the thin wasip1 entrypoint: wires the FKN dialer
  into the netstack, finds the emulator socket among the WASI preopens, and
  serves.
* `src/proxy/webvpn.go`: a `net.Conn` backed by a JS-side FKN socket, plus the
  wasmimport ABI for connect, send, receive, half-close, close, DNS, image
  streaming, and inbound socket polling.
  Non-blocking on the JS side; Go-side blocking is synthesised by polling +
  `time.Sleep`, which yields to the scheduler while the main thread fills
  buffers, the same poll-driven, zero-Asyncify model libtorrent's
  `library_fkn.js` uses.
* `public/webvpn-imports.js`: **worker side.** Implements the wasmimports as
  blocking round-trips to the main thread over the existing SharedArrayBuffer
  stream protocol (identical mechanism to upstream's `http_send`). This stays
  plain JS because it's `importScripts()`'d into the c2w stack worker.
* `src/webvpn-netstack.ts`: **main-thread side.** Owns the `@fkn/lib` sockets,
  virtual TCP listeners, and per-socket ring buffers serviced on each worker
  round-trip. Ports the copy-on-receive discipline from `library_fkn.js`.

## Build

```sh
make
# or, hermetically:
npm run make-docker
```

Either produces `dist/c2w-webvpn-proxy.wasm` (Go ≥ 1.23 required for direct
`make`; `make-docker` uses a pinned toolchain via Docker). The `.wasm` is
gitignored; build it locally.

## Container Lab

The responsive `/playground/` UI turns the network stack into a complete browser
demo. It supports two launches:

* **Shell** builds the Dockerfile and opens `/bin/sh` in the resulting image.
* **HTTP service** builds a dependency-free Alpine image, runs its default
  command, maps guest TCP port 8080 to an FKN virtual port, and sends `GET /`
  through the in-process FKN HTTP path.

The service launch uses `?publish=tcp:8080&run=default`. `publish` binds an FKN
loopback listener and maps accepted sockets into the guest. `run=default`
combines the image entrypoint and command instead of replacing them with
`/bin/sh`. The runtime waits for a guest-local HTTP response before starting an
`@fkn/lib/http` request to the returned virtual port.

HTTP mode places the Docker guest logs beside a live browser JavaScript console.
The console records the real `fetchContainer(url)` call, virtual route, response
time, HTTP status, headers, and returned body. The request button runs the same
path again so repeated responses remain visible.

The launcher streams its generated build script into the guest PTY in 512-byte
chunks; one large terminal paste can truncate a long Dockerfile payload. The
dependency-free HTTP preset uses BusyBox `nc -lk` and emits each complete framed
response from one shell-builtin `printf`, which keeps repeated requests stable
inside the nested runtime.

```sh
npm install
npm run dev-web
```

Open <http://localhost:1234/playground/>. The generated proxy and playground
WASM files under `public/` are gitignored and must already be built locally.

## Wiring into container2wasm's frontend

This is a drop-in replacement for `c2w-net-proxy.wasm`. Start from
container2wasm's [`examples/wasi-browser`](https://github.com/ktock/container2wasm/tree/main/examples/wasi-browser)
(or `examples/emscripten` for the QEMU/emscripten variant) and make three edits:

1. **Serve the files.** Put `c2w-webvpn-proxy.wasm` next to your other static
   assets and copy `public/webvpn-imports.js` there too (the in-repo runtime
   keeps the main-thread side in `src/webvpn-netstack.ts`).
   Point the stack worker at our proxy
   (`stackImageName = "c2w-webvpn-proxy.wasm"`).

2. **Worker side** (`stack-worker.js`) - register the egress imports:

   ```js
   importScripts(location.origin + "/webvpn-imports.js");
   // ...
   WebAssembly.instantiate(wasm, {
       "wasi_snapshot_preview1": wasi.wasiImport,
       "env": Object.assign(envHack(wasi), webvpnEnvImports(wasi)),
   })
   ```

3. **Main thread** (`stack.js`) - give the message handler first refusal:

   ```js
   import { createWebvpnNetstack } from "./webvpn-netstack";
   const webvpn = createWebvpnNetstack({ imageCache });

   // inside connect()'s returned handler, before the existing switch:
   if (webvpn.handle(req_, { streamStatus, streamLen, streamData })) {
       Atomics.store(streamCtrl, 0, 1);
       Atomics.notify(streamCtrl, 0);
       return;
   }
   ```

Because the guest reaches the internet directly (not through a TLS-terminating
HTTP proxy), you can also drop the `*_proxy` / `SSL_CERT_FILE` env vars that the
fetch-based example pre-configures.

Cross-origin isolation (`COOP: same-origin` + `COEP: require-corp`) is required
for `SharedArrayBuffer`, the same requirement container2wasm already has.

## Example: alpine + curl

`src/app/alpine-curl/Dockerfile` is the demo image (alpine + curl + bind-tools).
Build it, convert it to wasm, build the proxy, and bundle the runtime with:

```sh
./scripts/build-image.sh    # needs Docker w/ network + c2w + Go
```

It produces `build/` (Vite output). Note: `c2w` clones/compiles the emulator
and runs `apk add` **inside build containers**, so it needs an environment
where Docker build containers have outbound network; it will not run in a
network-restricted sandbox.

## Tests

`src/proxy/netstack/e2e_test.go` is a hermetic end-to-end test of the data path. It
can't drive the real emulator or FKN, so it substitutes the two ends with
production-equivalent interfaces:

* **guest** → a second gVisor stack with an ethernet link endpoint, wired to the
  proxy over a loopback connection carrying **real QEMU-protocol frames** (the
  exact framing the emulator emits).
* **FKN egress** → `net.Dial` to a local echo server.

It has the guest open TCP and UDP flows through the proxy, then injects a TCP
connection in the opposite direction and verifies native TCP half-close. The
tests cover destination extraction, DNS handling, outbound dialing, reverse
guest dialing, and bytes in both directions.

```sh
cd src/proxy && go test ./...
go test -race ./netstack -run TestTCPIngressToGuest -count=20
```

(gvisor-tap-vsock's dhcp service only compiles for wasm, so the native build
uses a no-op DHCP stub and the test guest is statically addressed.)

## Building Dockerfiles in the browser (spike)

`builder/` explores the bigger goal: building an *arbitrary Dockerfile* to wasm
**entirely in the browser**. Because `RUN` executes arch-specific binaries, this
reduces to running a rootless OCI builder (`buildah`) inside the emulated Linux
guest, with egress over this netstack. Phase 1 (the make-or-break "does
rootless/daemonless buildah build under the guest's constraints?") is
**validated**. See `builder/README.md`.

## Status & limitations

This is a working browser capability demo. Verified behavior includes:

* ✅ The Go proxy compiles to `GOOS=wasip1 GOARCH=wasm` (gVisor + gvisor-tap-vsock
  + the dial seam).
* ✅ The **core data path is tested end-to-end** natively (see Tests above):
  QEMU frames → gVisor termination → TCP/UDP forwarders → correct destination →
  dial → bytes both ways.
* ✅ Full browser boot with the real emulator, SharedArrayBuffer bridge, hosted
  FKN transport, live Docker Hub image pull, Buildah build, and interactive
  container shell.
* ✅ In-process FKN virtual TCP into the DHCP-addressed guest, including a
  browser HTTP request to an image-defined service without a relay hairpin.
* ✅ Responsive playground and runtime layouts at desktop and mobile widths.
* ⚠️ **Building a container image** with `c2w` needs Docker, and the build clones
  emulator/runc sources over TLS; in network-restricted/TLS-intercepting
  sandboxes those clones fail. Build the image where outbound TLS is unrestricted.

Known rough edges / TODO:

* **Throughput.** Full CPU emulation + a JS-side TCP/IP stack is far heavier than
  libtorrent's native-Asio port. Don't expect line rate.
* **recv latency.** Blocking reads poll on a `pollInterval` (20 ms) timer rather
  than blocking efficiently on the main thread. A `recv-is-readable`-style
  timeout notify (as upstream uses for the guest socket) would cut idle latency
  and CPU; see `webvpn.go`'s `Read`.
* **IPv6.** The stack is wired for IPv4 only (matches upstream). UDP sockets are
  `udp4`.
* **TCP DNS.** Only UDP `:53` is forwarded; large/truncated responses needing TCP
  fallback aren't handled yet.
* **Virtual protocols.** Guest routing currently supports TCP only. UDP remains
  outbound-only.
