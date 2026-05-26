# c2w-webvpn — real TCP/UDP egress for container2wasm, in the browser

Run **any Docker image** in the browser (via [container2wasm](https://github.com/ktock/container2wasm))
with **unrestricted TCP/UDP networking**, by routing the guest's traffic through
[`@webvpn`](https://www.npmjs.com/package/@webvpn/net) — the same WebTransport-to-VPN
egress used to give WASM-compiled libtorrent full peer connectivity.

This is the "Path B" from the design discussion: instead of intercepting BSD
socket syscalls of a single Emscripten program (which only works for programs
*you* compile), we let container2wasm emulate a full Linux kernel and intercept
at the **virtual NIC**, terminating the guest's IP traffic in an in-browser
gVisor netstack and dialing the real destination over `@webvpn`.

## Why this is needed

container2wasm already ships an in-browser network stack (`c2w-net-proxy.wasm`,
built on gVisor + gvisor-tap-vsock). But in the browser its egress is limited to
the **Fetch API**, so the guest can only reach **HTTP/HTTPS** sites that also
permit CORS — no raw TCP, no UDP, no `apt-get`, no DNS-over-UDP, no SSH, no
BitTorrent.

The limitation is *not* the netstack — gVisor terminates arbitrary TCP/UDP just
fine. It's the final hop: upstream dials out with Go's `net.Dial`, which doesn't
exist under `GOOS=wasip1`, so they fall back to `fetch()`. `@webvpn` provides
real browser-side TCP/UDP egress, which is exactly the missing hop.

## Architecture

```
 ┌── browser tab ─────────────────────────────────────────────────────────┐
 │                                                                         │
 │  Worker: emulator            Worker: this netstack         Main thread  │
 │  ┌──────────────┐  QEMU      ┌───────────────────────┐                  │
 │  │ TinyEMU /    │  ethernet  │ gVisor netstack        │   @webvpn/net    │
 │  │ Bochs + Linux│═══frames══▶│  • DHCP/ARP/DNS gw     │   @webvpn/dgram  │
 │  │ + your image │            │  • TCP/UDP forwarder ──┼──▶ wasmimport ──▶│──▶ VPN ──▶ internet
 │  └──────────────┘            └───────────────────────┘   (SAB round-trip)│
 │                                                                         │
 └─────────────────────────────────────────────────────────────────────────┘
```

The only thing this project changes vs. stock container2wasm is the forwarder's
**dial**: `net.Dial` → `dialWebvpn` (see `proxy/webvpn.go`). Everything else
(emulation, QEMU framing, DHCP, ARP, the gVisor TCP/IP termination) is reused
unchanged.

### The egress seam

* `proxy/netstack/` — assembles the gVisor stack from gvisor-tap-vsock's exported
  pieces (`tap.NewLinkEndpoint/NewSwitch/NewIPPool`, `dhcp.New`) and installs
  TCP + UDP forwarders that dial via an injected `DialFunc`. A small DNS
  forwarder on the gateway relays the guest's `:53` queries out over UDP (the
  guest's resolver is pointed at the gateway by DHCP). The dial is a parameter,
  not a hard dependency — the wasm build injects `@webvpn`, the test injects
  `net.Dial`.
* `proxy/main.go` — the thin wasip1 entrypoint: wires the `@webvpn` dialer into
  the netstack, finds the emulator socket among the WASI preopens, and serves.
* `proxy/webvpn.go` — a `net.Conn` backed by a JS-side `@webvpn` socket, plus the
  4-function wasmimport ABI (`webvpn_connect/send/recv/close`). Non-blocking on
  the JS side; Go-side blocking is synthesised by polling + `time.Sleep`, which
  yields to the scheduler while the main thread fills buffers — the same
  poll-driven, zero-Asyncify model libtorrent's `library_fkn.js` uses.
* `js/webvpn-imports.js` — **worker side.** Implements the wasmimports as
  blocking round-trips to the main thread over the existing SharedArrayBuffer
  stream protocol (identical mechanism to upstream's `http_send`).
* `js/webvpn-netstack.js` — **main-thread side.** Owns the `@webvpn` sockets and
  per-socket ring buffers, serviced on each worker round-trip. Ports the
  copy-on-receive discipline from `library_fkn.js`.

## Build

```sh
cd proxy
GOOS=wasip1 GOARCH=wasm go build -o c2w-webvpn-proxy.wasm .
```

(Go ≥ 1.23. The `.wasm` is gitignored — build it locally.)

## Wiring into container2wasm's frontend

This is a drop-in replacement for `c2w-net-proxy.wasm`. Start from
container2wasm's [`examples/wasi-browser`](https://github.com/ktock/container2wasm/tree/main/examples/wasi-browser)
(or `examples/emscripten` for the QEMU/emscripten variant) and make three edits:

1. **Serve the files.** Put `c2w-webvpn-proxy.wasm` in `htdocs/`, and copy
   `js/webvpn-imports.js` + `js/webvpn-netstack.js` there too. Point the stack
   worker at our proxy (`stackImageName = "c2w-webvpn-proxy.wasm"`).

2. **Worker side** (`stack-worker.js`) — register the egress imports:

   ```js
   importScripts(location.origin + "/webvpn-imports.js");
   // ...
   WebAssembly.instantiate(wasm, {
       "wasi_snapshot_preview1": wasi.wasiImport,
       "env": Object.assign(envHack(wasi), webvpnEnvImports(wasi)),
   })
   ```

3. **Main thread** (`stack.js`) — give the message handler first refusal:

   ```js
   import { connect as netConnect } from "@webvpn/net";
   import * as dgram from "@webvpn/dgram";
   const webvpn = createWebvpnNetstack({ net: { connect: netConnect }, dgram });

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
for `SharedArrayBuffer` — the same requirement container2wasm already has.

## Example: alpine + curl

`examples/alpine-curl/` is a turnkey build of a browser-runnable Alpine
container (with `curl` + DNS tools) wired to this netstack:

```sh
cd examples/alpine-curl && ./build.sh    # needs Docker w/ network + c2w + Go
```

It builds the image, converts it with `c2w`, builds the proxy, and assembles
`htdocs/`. Note: `c2w` clones/compiles the emulator and runs `apk add` **inside
build containers**, so it needs an environment where Docker build containers
have outbound network — it will not run in a network-restricted sandbox.

## Tests

`proxy/netstack/e2e_test.go` is a hermetic end-to-end test of the data path. It
can't drive the real emulator or `@webvpn`, so it substitutes the two ends with
production-equivalent interfaces:

* **guest** → a second gVisor stack with an ethernet link endpoint, wired to the
  proxy over a loopback connection carrying **real QEMU-protocol frames** (the
  exact framing the emulator emits).
* **`@webvpn` egress** → `net.Dial` to a local echo server.

It then has the guest open a TCP and a UDP flow "to the internet" and asserts
the proxy (a) terminates the flow in its gVisor stack, (b) extracts the correct
destination in the forwarder, (c) dials out via the seam, and (d) round-trips
bytes both ways.

```sh
cd proxy && go test ./netstack/ -v
# PASS: TestTCPForwardThroughProxy, TestUDPForwardThroughProxy
```

(The native build uses a no-op DHCP stub — gvisor-tap-vsock's dhcp service only
compiles for wasm — so the test guest is statically addressed.)

## Building Dockerfiles in the browser (spike)

`builder/` explores the bigger goal: building an *arbitrary Dockerfile* to wasm
**entirely in the browser**. Because `RUN` executes arch-specific binaries, this
reduces to running a rootless OCI builder (`buildah`) inside the emulated Linux
guest, with egress over this netstack. Phase 1 — the make-or-break "does
rootless/daemonless buildah build under the guest's constraints?" — is
**validated**. See `builder/README.md`.

## Status & limitations

This is a working **foundation**, not a turn-key product. What's verified vs. not:

* ✅ The Go proxy compiles to `GOOS=wasip1 GOARCH=wasm` (gVisor + gvisor-tap-vsock
  + the dial seam).
* ✅ The **core data path is tested end-to-end** natively (see Tests above):
  QEMU frames → gVisor termination → TCP/UDP forwarders → correct destination →
  dial → bytes both ways.
* ✅ The JS glue is syntactically valid and matches the upstream SAB protocol.
* ⚠️ **The full browser boot is not yet validated**: the real emulator + the JS
  glue + a live `@webvpn` server + cross-origin isolation. The two substituted
  ends in the test (synthetic guest, `net.Dial`) are exactly those pieces.
  Expect to debug the first browser boot.
* ⚠️ **Building a container image** with `c2w` needs Docker, and the build clones
  emulator/runc sources over TLS — in network-restricted/TLS-intercepting
  sandboxes those clones fail. Build the image where outbound TLS is unrestricted.

Known rough edges / TODO:

* **Throughput.** Full CPU emulation + a JS-side TCP/IP stack is far heavier than
  libtorrent's native-Asio port. Don't expect line rate.
* **recv latency.** Blocking reads poll on a `pollInterval` (2 ms) timer rather
  than blocking efficiently on the main thread. A `recv-is-readable`-style
  timeout notify (as upstream uses for the guest socket) would cut idle latency
  and CPU — see `webvpn.go`'s `Read`.
* **IPv6.** The stack is wired for IPv4 only (matches upstream). UDP sockets are
  `udp4`.
* **TCP DNS.** Only UDP `:53` is forwarded; large/truncated responses needing TCP
  fallback aren't handled yet.
* **listen/inbound.** Egress only. The guest can't accept inbound connections
  from the outside (there's no public ingress in this model).
