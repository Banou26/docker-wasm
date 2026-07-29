#!/usr/bin/env bash
set -euo pipefail

# Converts the in-browser Dockerfile builder into a wasm artifact, once per target
# architecture.
#
#   ./scripts/build-playground.sh              # both
#   ./scripts/build-playground.sh riscv64      # just the fast one
#
# riscv64 runs on c2w's TinyEMU backend: no asyncify instrumentation, a much
# smaller artifact, and the throughput that makes building in a tab bearable. It
# can only build base images that have a riscv64 variant, so amd64 stays as the
# compatibility path on Bochs and the page picks between them per Dockerfile.
#
# VM_MEMORY_SIZE_MB=512 is required for both: buildah's chroot-isolation RUN
# spawns a subprocess that OOMs at the default 128 MB.

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
[[ ${#targets[@]} -gt 0 ]] || targets=(riscv64 amd64)

git clone --quiet --depth 1 --branch "$c2w_version" \
    https://github.com/container2wasm/container2wasm.git "$assets"
c2w_commit="$(git -C "$assets" rev-parse HEAD)"
[[ "$c2w_commit" == "$c2w_expected_commit" ]] || {
    echo "$c2w_version resolved to unexpected commit $c2w_commit" >&2
    exit 1
}
# Grants CAP_SYS_ADMIN and mounts a tmpfs at the graphroot, so buildah gets a
# native overlay rather than stacking one on the guest's overlay-backed root.
# Touches only cmd/create-spec, so it applies to either architecture.
git -C "$assets" apply "$here/c2w-overlay-storage.patch"
(cd "$assets" && go build -trimpath -o "$temporary/c2w" ./cmd/c2w)

mkdir -p "$output_dir"

for arch in "${targets[@]}"; do
    case "$arch" in
        riscv64) dockerfile="$context/builder-riscv64.Dockerfile"; out="$output_dir/playground-riscv64.wasm" ;;
        amd64)   dockerfile="$context/Dockerfile";                 out="$output_dir/playground.wasm" ;;
        *) echo "unknown target architecture: $arch" >&2; exit 1 ;;
    esac

    image="c2w-playground-builder-$arch:$$"
    echo "==> building $image from $(basename "$dockerfile")"
    docker build --pull --platform "linux/$arch" --file "$dockerfile" --tag "$image" "$context"

    platform="$(docker image inspect "$image" --format '{{.Os}}/{{.Architecture}}')"
    [[ "$platform" == "linux/$arch" ]] || {
        echo "$image targets $platform instead of linux/$arch" >&2
        docker image rm "$image" >/dev/null 2>&1 || true
        exit 1
    }

    echo "==> converting to $(basename "$out")"
    "$temporary/c2w" \
        --assets "$assets" \
        --target-arch "$arch" \
        --build-arg VM_MEMORY_SIZE_MB=512 \
        "$image" "$out"

    docker image rm "$image" >/dev/null 2>&1 || true
    echo "==> $(basename "$out"): $(du -h "$out" | cut -f1)"
done
