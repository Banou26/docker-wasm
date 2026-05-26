#!/usr/bin/env bash
# Build the alpine+curl browser E2E: container wasm, netstack proxy, htdocs.
#
# Requirements (a normal dev box with internet):
#   - Docker with working network *inside build containers*
#   - Go >= 1.23
#   - c2w on PATH (build from github.com/container2wasm/container2wasm)
#   - node + npm
#
# Output: ./htdocs/ — serve cross-origin-isolated (use serve.cjs).
#
# Env vars:
#   FKN_API   override the @fkn/lib iframe URL baked into the bundle.
#             default https://fkn.app/api (prod, needs auth to expose its API).
#             For a fully local stack (recommended for testing):
#               FKN_API="http://127.0.0.1:1234/api.html"
#             alongside:  ~/dev/fkn/webvpn  (Rust WebTransport server)
#                         ~/dev/fkn/web    (vite dev w/ VITE_WEBVPN_{ORIGIN,CERT_HASH})
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
proxydir="$here/../../proxy"
jsdir="$here/../../js"
overlay="$here/overlay"
out="$here/htdocs"
mkdir -p "$out"

echo "==> 1/6  build the container image (alpine + curl + bind-tools)"
docker build -t c2w-webvpn-alpine-curl "$here"

echo "==> 2/6  convert the image to wasm with c2w"
c2w c2w-webvpn-alpine-curl "$out/out.wasm"

echo "==> 3/6  build the c2w-webvpn netstack proxy"
( cd "$proxydir" && GOOS=wasip1 GOARCH=wasm go build -tags osusergo -o "$out/c2w-webvpn-proxy.wasm" . )

echo "==> 4/6  fetch upstream wasi-browser htdocs"
src="$out/_c2w_src"
[ -d "$src" ] || git clone --depth 1 https://github.com/container2wasm/container2wasm "$src"
cp -R "$src/examples/wasi-browser/htdocs/." "$out/"
cp "$src/examples/wasi-browser/xterm-pty.conf" "$out/" 2>/dev/null || true
rm -rf "$src"
cp "$jsdir/webvpn-imports.js" "$jsdir/webvpn-netstack.js" "$out/"
# overlay: patched index.html / worker.js / stack.js + bundling sources
cp -R "$overlay/." "$out/"

echo "==> 5/6  npm install + esbuild the @webvpn bundle"
( cd "$out" && npm install --no-audit --no-fund --silent )
( cd "$out" && node esbuild-build.mjs )

if [ -n "${FKN_API:-}" ]; then
    echo "==> 5b   rewrite the @fkn/lib origin to: $FKN_API"
    # bundle hardcodes https://fkn.app and runtime-builds the iframe src via
    # \`\${origin}/api\`. Rewrite both so it points at your fkn/web dev server
    # (which serves /api.html, not /api).
    origin="${FKN_API%/*}"        # strip trailing /api.html or /api
    path="/${FKN_API##*/}"
    sed -i "s|https://fkn.app|$origin|g; s|\${_4}/api|\${_4}$path|g" "$out/webvpn-bundle.js"
fi

echo "==> 6/6  done."
echo
echo "Serve cross-origin-isolated:"
echo "    node $here/serve.cjs"
echo "Then open: http://127.0.0.1:8080/?net=webvpn"
echo
echo "Automated headless test (puppeteer + curl through the netstack):"
echo "    node $here/drive.cjs"
