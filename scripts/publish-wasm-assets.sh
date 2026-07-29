#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$here/.."
bucket=fkn-container-assets
asset_origin=https://container.fkn.app/wasm-assets
cache_control='public, max-age=31536000, immutable'
# Brotli, not gzip: it takes the riscv64 demo image from 54 MB to 16 MB, and
# every browser that can run the runtime at all negotiates it. Set
# ASSET_CONTENT_ENCODING=gzip to publish for a Pages Function that still assumes
# gzip.
content_encoding="${ASSET_CONTENT_ENCODING:-br}"
case "$content_encoding" in
br) compressed_suffix=.br ;;
gzip) compressed_suffix=.gz ;;
*) echo 'ASSET_CONTENT_ENCODING must be br or gzip' >&2; exit 2 ;;
esac
wrangler="$repo/node_modules/.bin/wrangler"

# One target per run. Publishing several would interleave manifest rewrites.
if [[ $# -ne 1 ]]; then
    echo 'Usage: npm run publish-wasm-assets -- playground|proxy|presets|all' >&2
    echo 'Exactly one target per run.' >&2
    exit 2
fi

case "${1:-}" in
playground)
    assets=('playground|/playground/playground.wasm|public/playground/playground.wasm|playground/playground|.wasm.js|application/wasm')
    ;;
proxy)
    assets=('proxy|/c2w-webvpn-proxy.wasm|public/c2w-webvpn-proxy.wasm|c2w-webvpn-proxy|.wasm.js|application/wasm')
    ;;
presets)
    assets=(
        'preset-shell|/presets/shell.wasm|public/presets/shell.wasm|presets/shell|.wasm.js|application/wasm'
        'preset-http|/presets/http.wasm|public/presets/http.wasm|presets/http|.wasm.js|application/wasm'
    )
    ;;
all)
    assets=(
        'playground|/playground/playground.wasm|public/playground/playground.wasm|playground/playground|.wasm.js|application/wasm'
        'proxy|/c2w-webvpn-proxy.wasm|public/c2w-webvpn-proxy.wasm|c2w-webvpn-proxy|.wasm.js|application/wasm'
        'preset-shell|/presets/shell.wasm|public/presets/shell.wasm|presets/shell|.wasm.js|application/wasm'
        'preset-http|/presets/http.wasm|public/presets/http.wasm|presets/http|.wasm.js|application/wasm'
    )
    ;;
*)
    echo 'Usage: npm run publish-wasm-assets -- playground|proxy|presets|all' >&2
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
next_preset_manifest="$repo/.wasm-publish.$$.presets.json"
cleanup() {
    rm -rf "$stage" "$next_manifest" "$next_preset_manifest" "$lock"
}
trap cleanup EXIT
mkdir "$stage"

manifest_paths=()
publishing_presets=0
for asset in "${assets[@]}"; do
    IFS='|' read -r name manifest_path source _ _ _ <<< "$asset"
    if [[ ! -f "$repo/$source" ]]; then
        echo "Missing artifact: $source" >&2
        exit 1
    fi
    snapshot="$stage/${source#public/}"
    mkdir -p "$(dirname "$snapshot")"
    cp "$repo/$source" "$snapshot"
    if [[ "$name" == preset-* ]]; then
        publishing_presets=1
    fi
    manifest_paths+=("$manifest_path")
done

if [[ "$publishing_presets" == 1 ]]; then
    cp "$repo/public/presets/preset-assets.json" "$stage/presets/preset-assets.json"
    "$here/verify-preset-images.sh" "$stage/presets"
    cp "$stage/presets/preset-assets.json" "$next_preset_manifest"
fi

manifest_before="$(sha256sum "$repo/wasm-assets.json")"
manifest_before="${manifest_before%% *}"
if [[ "$publishing_presets" == 1 ]]; then
    preset_manifest_before="$(sha256sum "$repo/preset-assets.json")"
    preset_manifest_before="${preset_manifest_before%% *}"
fi
node "$here/update-wasm-versions.cjs" \
    --source-root "$stage" \
    --output "$next_manifest" \
    "${manifest_paths[@]}"

node "$here/compress-wasm.cjs" "$stage"

for asset in "${assets[@]}"; do
    IFS='|' read -r name manifest_path source object_base object_suffix content_type <<< "$asset"
    version="$(node -e 'const versions = require(process.argv[1]); process.stdout.write(versions[process.argv[2]])' \
        "$next_manifest" "$manifest_path")"
    object="$object_base.$version$object_suffix"
    url="$asset_origin/$object"
    compressed="$stage/${source#public/}$compressed_suffix"

    "$wrangler" r2 object put "$bucket/$object" \
        --file "$compressed" \
        --content-type "$content_type" \
        --content-encoding "$content_encoding" \
        --cache-control "$cache_control" \
        --remote

    actual="$("$wrangler" r2 object get "$bucket/$object" --pipe --remote | sha256sum)"
    actual="${actual%% *}"
    [[ "$actual" == "$version" ]] || { echo "$name R2 digest does not match its object key" >&2; exit 1; }

    response="$(curl --silent --show-error --head --write-out $'\n%{http_code}' "$url")"
    status="${response##*$'\n'}"
    headers="${response%$'\n'*}"
    headers="${headers//$'\r'/}"
    headers="${headers,,}"

    # Content-Encoding is negotiated at the edge and comes back as whatever the
    # client asked for, so it says nothing about how the object was stored.
    # Fetching the body and decoding it is the only check that can tell.
    if [[ "$status" == 200 ]]; then
        [[ "$headers" == *"content-type: $content_type"* ]] || { echo "$name has the wrong content type" >&2; exit 1; }
        [[ "$headers" == *$'cache-control: public, max-age=31536000, immutable'* ]] || { echo "$name has the wrong cache policy" >&2; exit 1; }
    fi

    routed_actual=''
    if [[ "$status" == 200 ]]; then
        routed_actual="$(curl --fail --silent --show-error --compressed "$url" 2>/dev/null | sha256sum || true)"
        routed_actual="${routed_actual%% *}"
    fi

    if [[ "$status" != 200 || "$routed_actual" != "$version" ]]; then
        # Either the route does not resolve yet, or it hands back something that
        # does not decode to the artifact. The usual cause of the second is a
        # Pages Function older than this publication: it stamps a fixed
        # Content-Encoding, so a client asked to decode brotli as gzip fails.
        if [[ "$status" == 200 ]]; then
            detail="the route did not return the artifact when decoded, which happens when the deployed Pages Function labels $content_encoding objects as something else"
        else
            detail="the route returned HTTP $status"
        fi
        if [[ "${ALLOW_PENDING_ASSET_ROUTE:-0}" != 1 ]]; then
            echo "$name: $detail." >&2
            echo "The object itself is verified in R2. Deploy the Pages Function serving" >&2
            echo "/wasm-assets/* so it echoes the stored Content-Encoding, then rerun to verify" >&2
            echo "the public route. To publish now and check the route after the deploy, rerun" >&2
            echo "with ALLOW_PENDING_ASSET_ROUTE=1." >&2
            exit 1
        fi
        echo "$name is verified in R2. Live route check skipped: $detail." >&2
    fi
done

manifest_now="$(sha256sum "$repo/wasm-assets.json")"
manifest_now="${manifest_now%% *}"
[[ "$manifest_now" == "$manifest_before" ]] || { echo 'Artifact manifest changed during publication' >&2; exit 1; }
if [[ "$publishing_presets" == 1 ]]; then
    "$here/verify-preset-images.sh" "$stage/presets"
    preset_manifest_now="$(sha256sum "$repo/preset-assets.json")"
    preset_manifest_now="${preset_manifest_now%% *}"
    [[ "$preset_manifest_now" == "$preset_manifest_before" ]] || {
        echo 'Preset manifest changed during publication' >&2
        exit 1
    }
    mv "$next_preset_manifest" "$repo/preset-assets.json"
fi
mv "$next_manifest" "$repo/wasm-assets.json"
cleanup
trap - EXIT
