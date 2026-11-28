#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/carry-previous-static.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }

mkdir -p "$work/dist/_expo/static/js/web" "$work/prev/js/web"
echo new-entry >"$work/dist/_expo/static/js/web/entry-bbbbbbbb.js"
echo new-common >"$work/dist/_expo/static/js/web/__common-bbbbbbbb.js"
echo old-common >"$work/prev/js/web/__common-aaaaaaaa.js"
echo old-entry >"$work/prev/js/web/entry-aaaaaaaa.js"
# Same name in both: the new release's copy wins.
echo stale >"$work/prev/js/web/__common-bbbbbbbb.js"
echo "<html>new</html>" >"$work/dist/index.html"

bash "$script" "$work/dist" "$work/prev" >/dev/null

[[ -f "$work/dist/_expo/static/js/web/__common-aaaaaaaa.js" ]] || fail "the previous chunk was not carried"
[[ -f "$work/dist/_expo/static/js/web/entry-aaaaaaaa.js" ]] || fail "the previous entry was not carried"
[[ "$(cat "$work/dist/_expo/static/js/web/__common-bbbbbbbb.js")" == "new-common" ]] || fail "a carried file overwrote the new release's"
[[ "$(cat "$work/dist/index.html")" == "<html>new</html>" ]] || fail "the document was touched"

# Idempotent: a second run changes nothing.
bash "$script" "$work/dist" "$work/prev" >/dev/null
[[ "$(find "$work/dist/_expo/static" -type f | wc -l)" == "4" ]] || fail "a second run changed the file count"

# No previous release: a notice, not a failure.
bash "$script" "$work/dist" "$work/missing" >/dev/null || fail "a missing previous release failed the deploy"

# No static dir in the build: refuse.
mkdir -p "$work/empty"
if bash "$script" "$work/empty" "$work/prev" >/dev/null 2>&1; then fail "carried into a build with no static dir"; fi

echo "carry-previous-static: all cases passed"
