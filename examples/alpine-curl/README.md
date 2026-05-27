# alpine + curl — full browser E2E

A container (alpine + curl + bind-tools) running entirely in a browser via
container2wasm, with **real TCP/UDP egress through `@webvpn`**, terminated by
this repo's gVisor netstack proxy.

This is the end-to-end demo: a real shell inside a real Linux kernel inside a
real x86 emulator inside a wasm in a real browser tab, doing `curl https://...`
over a real WebTransport tunnel.

## What runs where

```
                      browser tab (cross-origin-isolated, COEP: credentialless)
 ┌─────────────────────────────────────────────────────────────────────────┐
 │                                                                         │
 │  worker.js (emulator)             webvpn-stack-worker.js               │
 │  ┌────────────────────┐  QEMU     ┌──────────────────────────────┐     │
 │  │ Bochs + Linux      │  frames   │ c2w-webvpn-proxy.wasm        │     │
 │  │ + alpine + curl    │═════════ ▶│  (gVisor netstack proxy)     │     │
 │  └────────────────────┘  fd 4     └──────────────┬───────────────┘     │
 │                                                  │ wasmimports          │
 │                          ┌───────────────────────▼────────────────┐    │
 │                          │ stack.js + webvpn-netstack.js (main)   │    │
 │                          │   per-flow sockets via @webvpn/{net,   │    │
 │                          │   dgram} → @fkn/lib RPC iframe         │    │
 │                          └───────────────────────┬────────────────┘    │
 └──────────────────────────────────────────────────┼────────────────────┘
                                                    │ postMessage RPC
                                                    ▼
                              ┌─────────────────────────────────────┐
                              │ iframe: fkn/web /api.html           │
                              │   WebTransport(serverCertHash) ──┐  │
                              └──────────────────────────────────│──┘
                                                                 ▼
                                                ┌─────────────────────────┐
                                                │ fkn/webvpn (Rust)       │
                                                │ WebTransport server     │
                                                │ → real TCP/UDP egress   │
                                                └─────────────────────────┘
```

## Reproduce

You need a normal dev machine (Docker w/ network, Go ≥ 1.23, node, c2w).

### 1. Start the local @webvpn backend (one-time)

```sh
# Rust WebTransport server (~/dev/fkn/webvpn) — listens on :4433/:4434
cd ~/dev/fkn/webvpn && ./target/release/webvpn &

# fkn/web vite dev (the @fkn/lib RPC iframe target)
CERT_HASH=$(curl -s http://localhost:4434/cert-hash)
cd ~/dev/fkn/web
VITE_WEBVPN_ORIGIN="https://localhost:4433" \
VITE_WEBVPN_CERT_HASH="$CERT_HASH" \
npx vite --port 1234 --host 127.0.0.1 &
```

### 2. Build the container + bundle

```sh
FKN_API="http://127.0.0.1:1234/api.html" ./scripts/build-image.sh
```

This produces (in `build/`):
- `out.wasm` — the alpine container (≈120 MB)
- `c2w-webvpn-proxy.wasm` — the netstack proxy
- `assets/index.js` — the Vite-bundled main thread (`@webvpn` + `@fkn/lib` + ghostty-web + xterm-pty; the `@fkn/lib` origin is rewritten to your local fkn/web)
- the upstream c2w `wasi-browser` worker scripts (`worker.js`, `stack-worker.js`, `browser_wasi_shim/`, `wasi-util.js`, `worker-util.js`, `ws-delegate.js`) + our `webvpn-stack-worker.js` + `webvpn-imports.js`

### 3. Serve cross-origin-isolated

```sh
node scripts/serve.cjs   # localhost:8080 with COOP=same-origin, COEP=credentialless
```

`COEP: credentialless` (rather than `require-corp`) is required so the
cross-origin `@fkn/lib` RPC iframe can load without itself sending COEP. The
served `index.html` also runs a tiny shim that sets `iframe.credentialless =
true` on every dynamically-created iframe.

### 4. Open or drive headlessly

Interactive:
```
http://127.0.0.1:8080/?net=webvpn
```
Then in the container terminal:
```
curl -ksS https://1.1.1.1/
```

Headless (puppeteer):
```sh
node scripts/drive.cjs    # boots alpine, runs the curl, asserts CURL_EXIT=0
```

## What was modified vs upstream

Our runtime is a single Vite TS package at the repo root. `scripts/build-image.sh`
stages upstream c2w files into `public/`, then `vite build` produces `build/`
from `src/`:

| location                         | role                                                                  |
| -------------------------------- | --------------------------------------------------------------------- |
| `index.html`                     | iframe-credentialless shim, `<script type=module>` entry              |
| `src/main.ts`                    | ghostty-web init, xterm-pty + TtyServer, worker wiring                |
| `src/stack.ts`                   | SAB-bridged message handler — first-refusal `webvpn.handle()`         |
| `src/webvpn-netstack.ts`         | `@webvpn` TCP/UDP socket pool + per-image cache + DoH DNS             |
| `src/registry.ts`                | in-browser OCI Registry V2 client + docker-archive tar assembler      |
| `public/worker.js`               | upstream c2w WASI worker, patched `?net=webvpn` branch (no cert dance)|
| `public/webvpn-stack-worker.js`  | classic worker running `c2w-webvpn-proxy.wasm`                        |
| `public/webvpn-imports.js`       | `importScripts()`'d into the stack worker                             |

## Known sharp edges

- `c2w`'s init writes an empty `/etc/resolv.conf` over the container's, so DNS
  via the gateway (`192.168.127.1`) isn't set unless you do
  `echo nameserver 192.168.127.1 > /etc/resolv.conf` inside the container.
  Curl by IP (e.g. `https://1.1.1.1/`) works out of the box.
- The proxy boots a full bochs/x86 emulator — first prompt typically takes
  several minutes.
