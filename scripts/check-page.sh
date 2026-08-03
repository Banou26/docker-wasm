#!/usr/bin/env bash

set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
origin="${ORIGIN:-http://localhost:1234}"

# attaches to an already-running chromium rather than launching one, because on this machine a second chromium hands off to the first instead of starting
if [ -z "${CDP:-}" ]; then
    port=$(pgrep -af -- '--remote-debugging-port=' 2>/dev/null \
        | grep -o -- '--remote-debugging-port=[0-9]\+' \
        | head -1 | cut -d= -f2 || true)
    if [ -z "$port" ]; then
        echo 'No chromium with a debugging port is running.' >&2
        echo 'Start one, for example:' >&2
        echo '  chromium --remote-debugging-port=9222 --user-data-dir=/tmp/cdp-profile' >&2
        exit 1
    fi
    CDP="http://127.0.0.1:$port"
fi

if ! curl -fsS -o /dev/null "$origin/dockerfile/"; then
    echo "Nothing is serving $origin. Run npm run dev-web first." >&2
    exit 1
fi

echo "browser: $CDP"
echo "origin:  $origin"

failed=0
for check in single build; do
    echo
    echo "########## $check"
    CDP="$CDP" ORIGIN="$origin" node "$root/test/page/$check.mjs" || failed=1
done

echo
[ "$failed" = 0 ] && echo "page: all checks passing" || echo "page: FAILURES above" >&2
exit "$failed"
