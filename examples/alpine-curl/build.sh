#!/usr/bin/env bash
# Build the alpine+curl browser E2E: container wasm, netstack proxy, htdocs.
#
# Requirements (a normal dev box with internet):
#   - Docker with working network *inside build containers*
#   - Go >= 1.23
#   - c2w on PATH (build from github.com/container2wasm/container2wasm)
#   - node + npm
#
# Output: ./htdocs/ — symlink to ../web/runtime/dist (vite output).
# Serve cross-origin-isolated via serve.cjs.
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
webroot="$here/../web"
runtimedir="$webroot/runtime"
runtimepublic="$runtimedir/public"
out="$runtimedir/dist"
mkdir -p "$runtimepublic"

echo "==> 1/6  build the container image (alpine + curl + bind-tools)"
docker build -t c2w-webvpn-alpine-curl "$here"

echo "==> 2/6  convert the image to wasm with c2w"
c2w c2w-webvpn-alpine-curl "$runtimepublic/out.wasm"

echo "==> 3/6  build the c2w-webvpn netstack proxy"
( cd "$proxydir" && GOOS=wasip1 GOARCH=wasm go build -tags osusergo -o "$runtimepublic/c2w-webvpn-proxy.wasm" . )

echo "==> 4/6  fetch upstream wasi-browser worker assets"
src="$runtimepublic/_c2w_src"
[ -d "$src" ] || git clone --depth 1 https://github.com/container2wasm/container2wasm "$src"
# Only copy upstream files we don't author. Our overlay sources live in web/runtime/src.
for f in browser_wasi_shim stack-worker.js wasi-util.js worker-util.js ws-delegate.js; do
    if [ -d "$src/examples/wasi-browser/htdocs/$f" ]; then
        cp -R "$src/examples/wasi-browser/htdocs/$f" "$runtimepublic/"
    elif [ -f "$src/examples/wasi-browser/htdocs/$f" ]; then
        cp "$src/examples/wasi-browser/htdocs/$f" "$runtimepublic/"
    fi
done
# c2w-net-proxy.wasm (the "browser" netstack mode — playground uses webvpn,
# but we keep it for completeness).
if [ -f "$src/examples/wasi-browser/htdocs/c2w-net-proxy.wasm" ]; then
    cp "$src/examples/wasi-browser/htdocs/c2w-net-proxy.wasm" "$runtimepublic/"
fi
rm -rf "$src"
# webvpn-imports.js is importScripts'd into webvpn-stack-worker.js — it lives in
# our top-level js/ and must end up alongside the worker in public/.
cp "$jsdir/webvpn-imports.js" "$runtimepublic/"

echo "==> 5/6  vite build"
( cd "$webroot" && npm install --no-audit --no-fund --silent )
( cd "$webroot" && npm run build )

if [ -n "${FKN_API:-}" ]; then
    echo "==> 5b   rewrite the @fkn/lib origin to: $FKN_API"
    origin="${FKN_API%/*}"        # strip trailing /api.html or /api
    path="/${FKN_API##*/}"
    # Vite emits hashed assets — rewrite every .js under dist/assets/. The bundled
    # iframe URL is a template literal `${<minified>}/api` where the minified
    # variable name is whatever Rollup chose this build (`_4` in esbuild, `JC`
    # or similar in Rollup). Match any identifier.
    for js in "$out"/assets/*.js; do
        [ -f "$js" ] && sed -i -E "s|https://fkn.app|$origin|g; s|(\\\$\{[A-Za-z_\\\$0-9]+\})/api(\`|\")|\\1${path}\\2|g" "$js"
    done
fi

# Backwards-compat: serve.cjs and drive.cjs still expect ./htdocs/. Symlink the
# vite output so old paths keep working.
ln -snf "../web/runtime/dist" "$here/htdocs"

echo "==> 6/6  done."
echo
echo "Serve cross-origin-isolated:"
echo "    node $here/serve.cjs"
echo "Then open: http://127.0.0.1:8080/?net=webvpn"
echo
echo "Automated headless test (puppeteer + curl through the netstack):"
echo "    node $here/drive.cjs"
