#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$here/.."
image=c2w-playground-builder
assets="$(mktemp -d)"
trap 'rm -rf "$assets"' EXIT

docker build -t "$image" "$repo/src/app/dockerfile-playground"
git clone --depth 1 --branch v0.8.4 \
    https://github.com/container2wasm/container2wasm.git "$assets"
git -C "$assets" apply "$here/c2w-overlay-storage.patch"
mkdir -p "$repo/public/playground"
c2w \
    --assets "$assets" \
    --build-arg VM_MEMORY_SIZE_MB=512 \
    "$image" "$repo/public/playground/playground.wasm"
