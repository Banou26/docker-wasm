#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$here/.."
imagedir="$repo/src/app/alpine-curl"
public="$repo/public"
mkdir -p "$public"

echo "==> 1/6  build the container image (alpine + curl + bind-tools)"
docker build -t c2w-webvpn-alpine-curl "$imagedir"

echo "==> 2/6  convert the image to wasm with c2w"
c2w \
    --build-arg SOURCE_REPO=https://github.com/container2wasm/container2wasm \
    --build-arg SOURCE_REPO_VERSION=v0.8.4 \
    c2w-webvpn-alpine-curl "$public/out.wasm"

echo "==> 3/6  build the c2w-webvpn netstack proxy"
( cd "$repo" && make ) && cp "$repo/dist/c2w-webvpn-proxy.wasm" "$public/c2w-webvpn-proxy.wasm"

echo "==> 4/6  fetch upstream wasi-browser worker assets"
src="$public/_c2w_src"
[ -d "$src" ] || git clone --depth 1 https://github.com/container2wasm/container2wasm "$src"
# only copy upstream files we don't author; our overlay sources live in src/
for f in browser_wasi_shim stack-worker.js wasi-util.js worker-util.js ws-delegate.js; do
    if [ -d "$src/examples/wasi-browser/htdocs/$f" ]; then
        cp -R "$src/examples/wasi-browser/htdocs/$f" "$public/"
    elif [ -f "$src/examples/wasi-browser/htdocs/$f" ]; then
        cp "$src/examples/wasi-browser/htdocs/$f" "$public/"
    fi
done
# the "browser" netstack mode: unused by the playground, which is on webvpn, but kept for completeness
if [ -f "$src/examples/wasi-browser/htdocs/c2w-net-proxy.wasm" ]; then
    cp "$src/examples/wasi-browser/htdocs/c2w-net-proxy.wasm" "$public/"
fi
rm -rf "$src"

echo "==> 5/6  vite build"
( cd "$repo" && npm install --no-audit --no-fund --silent )
( cd "$repo" && npm run build )

echo "==> 6/6  done."
echo
echo "Serve cross-origin-isolated:"
echo "    node $here/serve.cjs"
echo "Then open: http://127.0.0.1:8080/playground/?net=webvpn"
echo
echo "Automated headless test (puppeteer + curl through the netstack):"
echo "    node $here/drive.cjs"
