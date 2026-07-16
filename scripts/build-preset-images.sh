#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$here/.."
presets="$repo/src/app/dockerfile-playground/presets"
output_dir="$repo/public/presets"
temporary="$(mktemp -d)"
assets="$temporary/container2wasm"
source_label=dev.fkn.container-lab.preset-source-sha256
c2w_version=v0.8.4
c2w_expected_commit=6ed3d98882a2b22eafc1334f574c364a5b2b8c47
shell_source="$(sha256sum "$presets/shell.Dockerfile")"
shell_source="${shell_source%% *}"
http_source="$(sha256sum "$presets/http.Dockerfile")"
http_source="${http_source%% *}"
shell_image="fkn-container-preset-shell:${shell_source:0:16}-$$"
http_image="fkn-container-preset-http:${http_source:0:16}-$$"

cleanup() {
    docker image rm "$shell_image" "$http_image" >/dev/null 2>&1 || true
    rm -rf "$temporary"
}
trap cleanup EXIT

mkdir -p "$output_dir"
git clone --quiet --depth 1 --branch "$c2w_version" \
    https://github.com/container2wasm/container2wasm.git "$assets"
c2w_commit="$(git -C "$assets" rev-parse HEAD)"
[[ "$c2w_commit" == "$c2w_expected_commit" ]] || {
    echo "$c2w_version resolved to unexpected commit $c2w_commit" >&2
    exit 1
}
(cd "$assets" && go build -trimpath -o "$temporary/c2w" ./cmd/c2w)
docker build --pull --platform linux/amd64 --file "$presets/shell.Dockerfile" --tag "$shell_image" \
    --label "$source_label=$shell_source" "$presets"
docker build --pull --platform linux/amd64 --file "$presets/http.Dockerfile" --tag "$http_image" \
    --label "$source_label=$http_source" "$presets"

verify_image() {
    local image="$1"
    local expected_source="$2"
    local platform
    local actual_source

    platform="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")"
    [[ "$platform" == linux/amd64 ]] || {
        echo "$image targets $platform instead of linux/amd64" >&2
        exit 1
    }
    actual_source="$(docker image inspect --format "{{index .Config.Labels \"$source_label\"}}" "$image")"
    [[ "$actual_source" == "$expected_source" ]] || {
        echo "$image does not carry the current Dockerfile digest" >&2
        exit 1
    }
}

verify_image "$shell_image" "$shell_source"
verify_image "$http_image" "$http_source"

"$temporary/c2w" --assets "$assets" --target-arch amd64 "$shell_image" "$temporary/shell.wasm"
"$temporary/c2w" --assets "$assets" --target-arch amd64 "$http_image" "$temporary/http.wasm"

shell_wasm="$(sha256sum "$temporary/shell.wasm")"
shell_wasm="${shell_wasm%% *}"
http_wasm="$(sha256sum "$temporary/http.wasm")"
http_wasm="${http_wasm%% *}"

jq -n \
    --arg c2wVersion "$c2w_version" \
    --arg c2wCommit "$c2w_commit" \
    --arg shellSource "$shell_source" \
    --arg shellWasm "$shell_wasm" \
    --arg httpSource "$http_source" \
    --arg httpWasm "$http_wasm" \
    '{
        schemaVersion: 1,
        container2wasm: {version: $c2wVersion, commit: $c2wCommit},
        artifacts: {
            shell: {
                dockerfile: "shell.Dockerfile",
                dockerfileSha256: $shellSource,
                wasmSha256: $shellWasm,
                platform: "linux/amd64"
            },
            http: {
                dockerfile: "http.Dockerfile",
                dockerfileSha256: $httpSource,
                wasmSha256: $httpWasm,
                platform: "linux/amd64"
            }
        }
    }' > "$temporary/preset-assets.json"

"$here/verify-preset-images.sh" "$temporary"
mv "$temporary/shell.wasm" "$output_dir/shell.wasm"
mv "$temporary/http.wasm" "$output_dir/http.wasm"
mv "$temporary/preset-assets.json" "$output_dir/preset-assets.json"
rm -f "$output_dir/default-images.tar"

echo "Built $output_dir/shell.wasm and $output_dir/http.wasm"
