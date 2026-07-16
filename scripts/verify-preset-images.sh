#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$here/.."
artifact_dir="${1:-$repo/public/presets}"
presets="$repo/src/app/dockerfile-playground/presets"
metadata="$artifact_dir/preset-assets.json"

[[ -f "$metadata" ]] || { echo "Missing preset metadata: $metadata" >&2; exit 1; }
jq -e '
    .schemaVersion == 1 and
    .container2wasm.version == "v0.8.4" and
    .container2wasm.commit == "6ed3d98882a2b22eafc1334f574c364a5b2b8c47" and
    (.artifacts | keys == ["http", "shell"])
' "$metadata" >/dev/null || { echo 'Preset metadata has an invalid schema' >&2; exit 1; }

verify_artifact() {
    local name="$1"
    local dockerfile="$2"
    local artifact="$artifact_dir/$name.wasm"
    local expected_source
    local recorded_source
    local expected_wasm
    local actual_wasm
    local platform
    local magic

    [[ -f "$artifact" ]] || { echo "Missing preset artifact: $artifact" >&2; exit 1; }
    [[ "$(jq -r --arg name "$name" '.artifacts[$name].dockerfile' "$metadata")" == "$(basename "$dockerfile")" ]] || {
        echo "$name metadata names the wrong Dockerfile" >&2
        exit 1
    }
    expected_source="$(sha256sum "$dockerfile")"
    expected_source="${expected_source%% *}"
    recorded_source="$(jq -r --arg name "$name" '.artifacts[$name].dockerfileSha256' "$metadata")"
    [[ "$recorded_source" == "$expected_source" ]] || {
        echo "$name was not built from the current $(basename "$dockerfile")" >&2
        exit 1
    }
    expected_wasm="$(jq -r --arg name "$name" '.artifacts[$name].wasmSha256' "$metadata")"
    actual_wasm="$(sha256sum "$artifact")"
    actual_wasm="${actual_wasm%% *}"
    [[ "$actual_wasm" == "$expected_wasm" ]] || {
        echo "$name WASM digest does not match its metadata" >&2
        exit 1
    }
    platform="$(jq -r --arg name "$name" '.artifacts[$name].platform' "$metadata")"
    [[ "$platform" == linux/amd64 ]] || {
        echo "$name targets $platform instead of linux/amd64" >&2
        exit 1
    }
    magic="$(od -An -tx1 -N4 "$artifact" | tr -d '[:space:]')"
    [[ "$magic" == 0061736d ]] || {
        echo "$name is not a WebAssembly module" >&2
        exit 1
    }
    node "$here/verify-wasm-module.cjs" "$artifact"
}

verify_artifact shell "$presets/shell.Dockerfile"
verify_artifact http "$presets/http.Dockerfile"

echo "Verified $artifact_dir/shell.wasm and $artifact_dir/http.wasm"
