#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$here/.."
context="$repo/src/app/dockerfile-playground"
output_dir="$repo/public/playground"
c2w_version=v0.8.4
c2w_expected_commit=6ed3d98882a2b22eafc1334f574c364a5b2b8c47

temporary="$(mktemp -d)"
assets="$temporary/container2wasm"
trap 'rm -rf "$temporary"' EXIT

targets=("$@")
[[ ${#targets[@]} -gt 0 ]] || targets=(runner:riscv64 runner:amd64 builder:riscv64 builder:amd64)

git clone --quiet --depth 1 --branch "$c2w_version" \
    https://github.com/container2wasm/container2wasm.git "$assets"
c2w_commit="$(git -C "$assets" rev-parse HEAD)"
[[ "$c2w_commit" == "$c2w_expected_commit" ]] || {
    echo "$c2w_version resolved to unexpected commit $c2w_commit" >&2
    exit 1
}
# grants CAP_SYS_ADMIN and mounts a tmpfs at the graphroot, so buildah gets a native overlay
# rather than stacking one on the guest's overlay-backed root; touches only cmd/create-spec, so one apply covers either architecture
git -C "$assets" apply "$here/c2w-overlay-storage.patch"
(cd "$assets" && go build -trimpath -o "$temporary/c2w" ./cmd/c2w)

mkdir -p "$output_dir"

for target in "${targets[@]}"; do
    guest="${target%%:*}"
    arch="${target##*:}"
    # a bare riscv64/amd64 target still means the builder guest, so existing invocations keep working; <guest>:<arch> is the newer form
    [[ "$target" == *:* ]] || { guest=builder; arch="$target"; }

    case "$guest:$arch" in
        runner:riscv64)  dockerfile="$context/runner.Dockerfile";          out="$output_dir/runner-riscv64.wasm" ;;
        runner:amd64)    dockerfile="$context/runner.Dockerfile";          out="$output_dir/runner.wasm" ;;
        builder:riscv64) dockerfile="$context/builder-riscv64.Dockerfile"; out="$output_dir/playground-riscv64.wasm" ;;
        builder:amd64)   dockerfile="$context/Dockerfile";                 out="$output_dir/playground.wasm" ;;
        *) echo "unknown target: $target (expected <runner|builder>:<riscv64|amd64>)" >&2; exit 1 ;;
    esac

    image="c2w-playground-$guest-$arch:$$"
    echo "==> building $image from $(basename "$dockerfile")"
    docker build --pull --platform "linux/$arch" --file "$dockerfile" --tag "$image" "$context"

    platform="$(docker image inspect "$image" --format '{{.Os}}/{{.Architecture}}')"
    [[ "$platform" == "linux/$arch" ]] || {
        echo "$image targets $platform instead of linux/$arch" >&2
        docker image rm "$image" >/dev/null 2>&1 || true
        exit 1
    }

    # the builder needs 512 MB because buildah's chroot-isolation RUN spawns a subprocess that OOMs at the default 128
    memory=512
    # the runner has no such subprocess, but it does extract a whole base rootfs and run the Dockerfile's RUN steps inside it, so it still needs headroom
    [[ "$guest" == runner ]] && memory=256

    echo "==> converting to $(basename "$out")"
    "$temporary/c2w" \
        --assets "$assets" \
        --target-arch "$arch" \
        --build-arg VM_MEMORY_SIZE_MB="$memory" \
        "$image" "$out"

    docker image rm "$image" >/dev/null 2>&1 || true
    echo "==> $(basename "$out"): $(du -h "$out" | cut -f1)"
done
