#!/usr/bin/env bash
#
# `docker` is a real dependency here, not a convenience: the checks that matter are differential.
# Pass --offline to run only the checks that do not need it.

set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
offline=false
[ "${1:-}" = "--offline" ] && offline=true

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

cat > "$out/entry.ts" <<EOF
export * from '$root/src/dockerfile'
export * from '$root/src/build-script'
export * from '$root/src/layers'
export * from '$root/src/launch'
export { isPresetWasmURL, PRESET_DOCKERFILES } from '$root/src/presets'
EOF
# the preset Dockerfiles are `?raw` imports, which vite resolves and esbuild does not, so they need a loader rather than a stub
npx --no-install esbuild --bundle --format=esm --platform=node --log-level=warning \
  --define:__WASM_ASSET_VERSIONS__='{}' --define:__WASM_ASSET_BASE__='""' \
  --loader:.Dockerfile=text \
  --outfile="$out/fastpath.mjs" "$out/entry.ts"
cp "$root"/test/fast-path/*.mjs "$out/"

checks=(unit)
if [ "$offline" = false ]; then
  if docker version >/dev/null 2>&1; then
    checks+=(diff launch opaque chroot)
  else
    echo "docker is not available, running the offline checks only" >&2
  fi
fi

failed=0
for check in "${checks[@]}"; do
  echo
  echo "=== $check ==="
  node "$out/$check.mjs" || failed=1
done

echo
[ "$failed" = 0 ] && echo "fast path: all checks passing" || echo "fast path: FAILURES above" >&2
exit "$failed"
