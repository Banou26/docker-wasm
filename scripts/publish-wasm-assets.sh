#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$here/.."
bucket=fkn-container-assets
asset_origin=https://container.fkn.app/wasm-assets
cache_control='public, max-age=31536000, immutable'
wrangler="$repo/node_modules/.bin/wrangler"

case "${1:-}" in
playground)
    assets=('playground|/playground/playground.wasm|public/playground/playground.wasm|playground/playground')
    ;;
proxy)
    assets=('proxy|/c2w-webvpn-proxy.wasm|public/c2w-webvpn-proxy.wasm|c2w-webvpn-proxy')
    ;;
all)
    assets=(
        'playground|/playground/playground.wasm|public/playground/playground.wasm|playground/playground'
        'proxy|/c2w-webvpn-proxy.wasm|public/c2w-webvpn-proxy.wasm|c2w-webvpn-proxy'
    )
    ;;
*)
    echo 'Usage: npm run publish-wasm-assets -- playground|proxy|all' >&2
    exit 2
    ;;
esac

if [[ ! -x "$wrangler" ]]; then
    echo 'Wrangler is not installed. Run npm ci first.' >&2
    exit 1
fi

lock="$repo/.wasm-publish.lock"
if ! mkdir "$lock"; then
    echo 'Another WASM publication is already running.' >&2
    exit 1
fi

stage="$repo/.wasm-publish.$$.d"
next_manifest="$repo/.wasm-publish.$$.json"
cleanup() {
    rm -rf "$stage" "$next_manifest" "$lock"
}
trap cleanup EXIT
mkdir "$stage"

manifest_paths=()
for asset in "${assets[@]}"; do
    IFS='|' read -r _ manifest_path source _ <<< "$asset"
    if [[ ! -f "$repo/$source" ]]; then
        echo "Missing WASM asset: $source" >&2
        exit 1
    fi
    snapshot="$stage/${source#public/}"
    mkdir -p "$(dirname "$snapshot")"
    cp "$repo/$source" "$snapshot"
    manifest_paths+=("$manifest_path")
done

manifest_before="$(sha256sum "$repo/wasm-assets.json")"
manifest_before="${manifest_before%% *}"
node "$here/update-wasm-versions.cjs" \
    --source-root "$stage" \
    --output "$next_manifest" \
    "${manifest_paths[@]}"

node "$here/compress-wasm.cjs" "$stage"

for asset in "${assets[@]}"; do
    IFS='|' read -r name manifest_path source object_base <<< "$asset"
    version="$(node -e 'const versions = require(process.argv[1]); process.stdout.write(versions[process.argv[2]])' \
        "$next_manifest" "$manifest_path")"
    object="$object_base.$version.wasm.js"
    url="$asset_origin/$object"
    compressed="$stage/${source#public/}.gz"

    "$wrangler" r2 object put "$bucket/$object" \
        --file "$compressed" \
        --content-type application/wasm \
        --content-encoding gzip \
        --cache-control "$cache_control" \
        --remote

    headers="$(curl --fail --silent --show-error --head \
        -H 'Accept-Encoding: gzip' "$url")"
    headers="${headers//$'\r'/}"
    headers="${headers,,}"
    [[ "$headers" == *$'content-type: application/wasm'* ]] || { echo "$name has the wrong content type" >&2; exit 1; }
    [[ "$headers" == *$'content-encoding: gzip'* ]] || { echo "$name has the wrong content encoding" >&2; exit 1; }
    [[ "$headers" == *$'cache-control: public, max-age=31536000, immutable'* ]] || { echo "$name has the wrong cache policy" >&2; exit 1; }

    actual="$(curl --fail --silent --show-error --compressed "$url" | sha256sum)"
    actual="${actual%% *}"
    [[ "$actual" == "$version" ]] || { echo "$name digest does not match its object key" >&2; exit 1; }
done

manifest_now="$(sha256sum "$repo/wasm-assets.json")"
manifest_now="${manifest_now%% *}"
[[ "$manifest_now" == "$manifest_before" ]] || { echo 'WASM manifest changed during publication' >&2; exit 1; }
mv "$next_manifest" "$repo/wasm-assets.json"
cleanup
trap - EXIT
