#!/usr/bin/env bash
# Build the alpine+curl E2E example: a browser-runnable container wasm with real
# TCP/UDP egress via @webvpn.
#
# REQUIREMENTS (none of which are satisfiable in a network-restricted sandbox —
# run this on a normal dev machine):
#   - Docker with working network *inside build containers* (c2w clones and
#     compiles the emulator/runc, and `apk add curl` needs the Alpine CDN).
#   - Go >= 1.23 (to build the proxy and, if needed, c2w itself).
#   - The `c2w` CLI on PATH (build from github.com/container2wasm/container2wasm,
#     or grab a release binary).
#
# Output: ./htdocs/ — serve it cross-origin-isolated (COOP/COEP) and open
#   index.html?net=webvpn
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
proxydir="$here/../../proxy"
jsdir="$here/../../js"
out="$here/htdocs"
mkdir -p "$out"

echo "==> 1/4  build the container image (alpine + curl)"
docker build -t c2w-webvpn-alpine-curl "$here"

echo "==> 2/4  convert the image to wasm with c2w"
c2w c2w-webvpn-alpine-curl "$out/out.wasm"

echo "==> 3/4  build the c2w-webvpn netstack proxy"
( cd "$proxydir" && GOOS=wasip1 GOARCH=wasm go build -o "$out/c2w-webvpn-proxy.wasm" . )

echo "==> 4/4  assemble the browser frontend"
# Start from container2wasm's wasi-browser example, then overlay our proxy +
# egress glue. We don't vendor upstream's htdocs here (it evolves); fetch it.
if [ ! -d "$out/_c2w_src" ]; then
  git clone --depth 1 https://github.com/container2wasm/container2wasm "$out/_c2w_src"
fi
cp -R "$out/_c2w_src/examples/wasi-browser/htdocs/." "$out/"
cp "$out/_c2w_src/examples/wasi-browser/xterm-pty.conf" "$out/" 2>/dev/null || true
cp "$jsdir/webvpn-imports.js" "$jsdir/webvpn-netstack.js" "$out/"

cat <<'NOTE'

==> Done. htdocs/ is assembled, BUT three wiring edits remain (see
    ../../README.md "Wiring into container2wasm's frontend"):

  1. point the stack worker at "c2w-webvpn-proxy.wasm" (not c2w-net-proxy.wasm)
  2. stack-worker.js: importScripts("/webvpn-imports.js") + Object.assign the
     env imports
  3. stack.js: construct createWebvpnNetstack({net,dgram}) from @webvpn and give
     its .handle() first refusal in the message handler

Then serve cross-origin-isolated, e.g.:

  npx http-server htdocs -p 8080 \
    --cors -c-1 \
    -H "Cross-Origin-Opener-Policy: same-origin" \
    -H "Cross-Origin-Embedder-Policy: require-corp"

and open  http://localhost:8080/?net=webvpn
Inside the container terminal:  curl -sS https://example.com
NOTE
