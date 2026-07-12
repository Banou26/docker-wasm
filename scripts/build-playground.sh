#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$here/.."
image=c2w-playground-builder

docker build -t "$image" "$repo/src/app/dockerfile-playground"
mkdir -p "$repo/public/playground"
c2w \
    --build-arg SOURCE_REPO=https://github.com/container2wasm/container2wasm \
    --build-arg SOURCE_REPO_VERSION=v0.8.4 \
    --build-arg VM_MEMORY_SIZE_MB=512 \
    "$image" "$repo/public/playground/playground.wasm"
