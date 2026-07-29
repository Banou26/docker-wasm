#!/usr/bin/env bash
#
# Checks the chroot fast path: the Dockerfile parser, the build planner, and the
# shell script the guest runs.
#
# Most of these are differential rather than unit checks. The fast path's failure
# mode is a build that succeeds and produces a different image, which no
# assertion about the generated text can catch, so the checks that matter run the
# same Dockerfile through `docker build` and through the fast path and compare
# what the two produced. `docker` is therefore a real dependency here, not a
# convenience; pass --offline to run only the checks that do not need it.
#
#   npm run check-fast-path
#   npm run check-fast-path -- --offline

set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
offline=false
[ "${1:-}" = "--offline" ] && offline=true

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

# The modules under test are TypeScript and import each other, so they are
# bundled once into something node can run directly.
cat > "$out/entry.ts" <<EOF
export * from '$root/src/dockerfile'
export * from '$root/src/build-script'
export * from '$root/src/layers'
EOF
npx --no-install esbuild --bundle --format=esm --platform=node --log-level=warning \
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
