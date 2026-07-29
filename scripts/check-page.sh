#!/usr/bin/env bash
#
# Drives the real page in a real browser: picks a guest from the build plan,
# boots it, runs a build, and checks what the built image contains.
#
# This needs a chromium with a debugging port open, and it attaches to one that
# is already running rather than launching its own, for two reasons. A headless
# chromium stalls on the in-page gateway fetch, which has twice looked like a bug
# in this project and twice been the harness. And on this machine a second
# chromium hands off to the first instead of starting, so launching is not
# available anyway.
#
#   npm run dev-web                     # the page under test, on :1234
#   npm run check-page
#
# Point it somewhere else with ORIGIN, or at a specific browser with CDP.

set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
origin="${ORIGIN:-http://localhost:1234}"

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
# single: the editor page, which is where a reader actually starts.
# build:  the runtime entry on its own, which shared links and the library use.
for check in single build; do
    echo
    echo "########## $check"
    CDP="$CDP" ORIGIN="$origin" node "$root/test/page/$check.mjs" || failed=1
done

echo
[ "$failed" = 0 ] && echo "page: all checks passing" || echo "page: FAILURES above" >&2
exit "$failed"
