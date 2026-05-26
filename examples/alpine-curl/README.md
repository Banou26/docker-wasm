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
cd examples/alpine-curl
FKN_API="http://127.0.0.1:1234/api.html" ./build.sh
```

This produces:
- `htdocs/out.wasm` — the alpine container (≈120 MB)
- `htdocs/c2w-webvpn-proxy.wasm` — the netstack proxy
- `htdocs/webvpn-bundle.js` — `@webvpn` + `@fkn/lib` bundled (rewritten to your local fkn/web)
- the upstream `wasi-browser` frontend + our overlay (patched `index.html`, `stack.js`, `worker.js` + `webvpn-stack-worker.js`)

### 3. Serve cross-origin-isolated

```sh
node serve.cjs   # localhost:8080 with COOP=same-origin, COEP=credentialless
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
node drive.cjs    # boots alpine, runs the curl, asserts CURL_EXIT=0
```

## What was modified vs upstream

The overlay (`overlay/`) carries our changes to upstream c2w's wasi-browser
frontend so `build.sh` is hands-off:

| file                       | change                                                                |
| -------------------------- | --------------------------------------------------------------------- |
| `index.html`               | iframe-credentialless shim, `?net=webvpn` mode, expose `window.xterm` |
| `worker.js`                | `?net=webvpn` branch — no SSL cert dance, no `*_proxy` env            |
| `stack.js`                 | first-refusal `webvpn.handle()` in the message handler                |
| `webvpn-stack-worker.js`   | new — runs `c2w-webvpn-proxy.wasm` with `webvpnEnvImports`            |
| `webvpn-entry.js`          | new — esbuild entry that exposes `@webvpn` + helpers as globals       |
| `esbuild-build.mjs`/shim   | new — bundles the @webvpn deps with node-builtin polyfills            |
| `package.json`             | new — npm deps for the bundle                                         |

## Known sharp edges

- `c2w`'s init writes an empty `/etc/resolv.conf` over the container's, so DNS
  via the gateway (`192.168.127.1`) isn't set unless you do
  `echo nameserver 192.168.127.1 > /etc/resolv.conf` inside the container.
  Curl by IP (e.g. `https://1.1.1.1/`) works out of the box.
- The proxy boots a full bochs/x86 emulator — first prompt typically takes
  several minutes.
