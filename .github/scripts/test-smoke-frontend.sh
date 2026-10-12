#!/usr/bin/env bash

set -euo pipefail

# Drives .github/scripts/smoke-frontend.sh against a stubbed `curl`. Its exit code
# is what decides whether `deploy-frontends.yml` keeps a production promotion or
# rolls it back, so that verdict is what every scenario asserts.
#
# The case it exists for: just after a promotion, a document served by a node
# already on the new version names a chunk that a node still on the old version
# answers with the SPA fallback (`index.html`). That is a rollout in progress, not
# a broken release. Measured twice on 2026-10-10, the gate rolled back two good
# releases on it, and a re-run of the same build passed both times. A chunk that
# never arrives, or that fails any other way, must still fail.

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
smoke_script="$repository_root/.github/scripts/smoke-frontend.sh"
test_directory="$(mktemp -d)"
temporary_root="$(realpath "${TMPDIR:-/tmp}")"
test_directory="$(realpath "$test_directory")"

cleanup_test_directory() {
  if [[ "$test_directory" == "$temporary_root/"* && -d "$test_directory" ]]; then
    rm -rf -- "$test_directory"
  else
    echo "Refusing to remove unexpected test directory: $test_directory" >&2
  fi
}
trap cleanup_test_directory EXIT

readonly CHUNK='/_expo/static/js/web/entry-0632c7a2a4def4be4e24b5be926c81f5.js'

# Stubbed curl. The document names one chunk; the chunk answers with the
# fallback for its first STUB_CHUNK_FALLBACKS requests, then as STUB_CHUNK_STATUS.
mkdir -p "$test_directory/bin"
cat >"$test_directory/bin/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
headers='' output='' url=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dump-header) headers="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    --header|--max-time|--retry|--retry-delay|--max-redirs|--write-out) shift 2 ;;
    --*) shift ;;
    *) url="$1"; shift ;;
  esac
done
if [[ "$url" != *"/_expo/static/"* ]]; then
  printf 'HTTP/2 200\r\ncontent-type: text/html\r\ncache-control: no-cache\r\n\r\n' >"$headers"
  printf '<html><script src="%s"></script></html>' "$STUB_CHUNK" >"$output"
  printf '200'
  exit 0
fi
count_file="$STUB_STATE/chunk-requests"
count=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))
echo "$count" >"$count_file"
if [[ "$count" -le "$STUB_CHUNK_FALLBACKS" ]]; then
  printf 'HTTP/2 200\r\ncontent-type: text/html\r\n\r\n' >"$headers"
  printf '<html></html>' >"$output"
  printf '200'
  exit 0
fi
printf 'HTTP/2 %s\r\ncontent-type: text/javascript\r\ncache-control: public, max-age=31536000, immutable\r\n\r\n' "$STUB_CHUNK_STATUS" >"$headers"
printf 'console.log(1)' >"$output"
printf '%s' "$STUB_CHUNK_STATUS"
STUB
chmod +x "$test_directory/bin/curl"

failures=0

# run_scenario NAME FALLBACKS STATUS EXPECTED_EXIT EXPECTED_REQUESTS
run_scenario() {
  local name="$1" fallbacks="$2" chunk_status="$3" expected_exit="$4" expected_requests="$5"
  local state="$test_directory/$name"
  mkdir -p "$state"
  local exit_code=0
  PATH="$test_directory/bin:$PATH" \
    STUB_STATE="$state" STUB_CHUNK="$CHUNK" \
    STUB_CHUNK_FALLBACKS="$fallbacks" STUB_CHUNK_STATUS="$chunk_status" \
    WEB_ORIGIN='https://shell.example' \
    SMOKE_DOCUMENT_SAMPLES=1 SMOKE_DOCUMENT_INTERVAL=0 \
    SMOKE_ASSET_PROPAGATION_ATTEMPTS=4 SMOKE_ASSET_PROPAGATION_INTERVAL=0 \
    bash "$smoke_script" >"$state/output" 2>&1 || exit_code=$?
  local requests
  requests="$(cat "$state/chunk-requests" 2>/dev/null || echo 0)"
  if [[ "$exit_code" -ne "$expected_exit" || "$requests" -ne "$expected_requests" ]]; then
    echo "FAIL $name: exit $exit_code (expected $expected_exit), chunk requests $requests (expected $expected_requests)"
    sed 's/^/    /' "$state/output"
    failures=$((failures + 1))
  else
    echo "ok   $name"
  fi
}

# A chunk served at once is checked once.
run_scenario served-at-once 0 200 0 1
# The rollout reaches the node on the third try: the release is kept.
run_scenario served-once-the-rollout-arrives 2 200 0 3
# The chunk is still missing when the window closes: the release ships without it.
run_scenario never-served 9 200 1 4
# A real failure is not a rollout in progress: no waiting, no retrying it away.
run_scenario server-error 0 500 1 1

if [[ "$failures" -gt 0 ]]; then
  echo "$failures scenario(s) failed."
  exit 1
fi
echo "All smoke-frontend scenarios passed."
