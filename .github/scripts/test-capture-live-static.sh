#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/capture-live-static.sh"
work="$(mktemp -d)"
server_pid=""
trap '[[ -n "$server_pid" ]] && kill "$server_pid" 2>/dev/null || true; rm -rf "$work"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }

site="$work/site"
mkdir -p "$site/_expo/static/js/web" "$site/_expo/static/css"
cat >"$site/index.html" <<'HTML'
<html><link href="/_expo/static/css/global-aaaa.css"><script src="/_expo/static/js/web/entry-aaaa.js"></script></html>
HTML
echo "body{}" >"$site/_expo/static/css/global-aaaa.css"
# The entry names a lazy chunk by its full path; the lazy chunk names another;
# the entry also names one the live release does not serve.
echo 'load("_expo/static/js/web/lazy-bbbb.js");load("_expo/static/js/web/gone-cccc.js")' >"$site/_expo/static/js/web/entry-aaaa.js"
echo 'load("_expo/static/js/web/deep-dddd.js")' >"$site/_expo/static/js/web/lazy-bbbb.js"
echo "deep" >"$site/_expo/static/js/web/deep-dddd.js"

port=18765
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$site" >/dev/null 2>&1 &
server_pid=$!
for _ in $(seq 1 50); do curl -s "http://127.0.0.1:$port/" >/dev/null && break; sleep 0.1; done

bash "$script" "http://127.0.0.1:$port" "$work/out" >/dev/null
for file in css/global-aaaa.css js/web/entry-aaaa.js js/web/lazy-bbbb.js js/web/deep-dddd.js; do
  [[ -f "$work/out/$file" ]] || fail "$file was not captured (the name graph must be followed transitively)"
done
[[ ! -e "$work/out/js/web/gone-cccc.js" ]] || fail "a name the origin does not serve was captured"
[[ ! -e "$work/out/index.html" ]] || fail "the document was captured"

# An unreachable origin is a notice, not a failure, and leaves nothing behind.
kill "$server_pid"
wait "$server_pid" 2>/dev/null || true
server_pid=""
bash "$script" "http://127.0.0.1:$port" "$work/none" >/dev/null || fail "an unreachable origin failed the deploy"
[[ -z "$(ls -A "$work/none")" ]] || fail "an unreachable origin left files behind"

echo "capture-live-static: all cases passed"
