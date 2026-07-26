#!/usr/bin/env bash

set -euo pipefail

API_ORIGIN="${API_ORIGIN:-https://api.mention.earth}"
WEB_ORIGIN="${WEB_ORIGIN:-https://mention.earth}"
smoke_dir="$(mktemp -d)"
temporary_root="$(realpath "${TMPDIR:-/tmp}")"
smoke_dir="$(realpath "$smoke_dir")"

cleanup_smoke_dir() {
  if [[ "$smoke_dir" == "$temporary_root/"* && -d "$smoke_dir" ]]; then
    rm -rf -- "$smoke_dir"
  else
    echo "::warning::Refusing to remove unexpected smoke directory: $smoke_dir"
  fi
}
trap cleanup_smoke_dir EXIT

request() {
  local name="$1"
  shift
  curl \
    --silent \
    --show-error \
    --max-time 20 \
    --retry 4 \
    --retry-delay 2 \
    --retry-all-errors \
    --max-redirs 0 \
    --dump-header "$smoke_dir/$name.headers" \
    --output "$smoke_dir/$name.body" \
    --write-out '%{http_code}' \
    "$@"
}

expect_status() {
  local actual="$1"
  local expected="$2"
  local name="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "::error::$name returned HTTP $actual (expected $expected)."
    exit 1
  fi
}

expect_json_response() {
  local name="$1"
  if ! grep -Eiq '^content-type: *application/(activity\+json|ld\+json|json)' \
    "$smoke_dir/$name.headers"; then
    echo "::error::$name did not return a JSON/ActivityPub content type."
    exit 1
  fi
}

status="$(request readiness "$API_ORIGIN/health/ready")"
expect_status "$status" 200 "readiness"

status="$(request anonymous-feed "$API_ORIGIN/feed/mtn?descriptor=for_you&limit=1")"
expect_status "$status" 200 "anonymous feed"

status="$(request webfinger "$WEB_ORIGIN/.well-known/webfinger?resource=acct:__smoke_missing__@mention.earth")"
expect_status "$status" 404 "webfinger"
expect_json_response webfinger

status="$(request actor \
  --header 'Accept: application/activity+json' \
  "$WEB_ORIGIN/ap/users/__smoke_missing__")"
expect_status "$status" 404 "ActivityPub actor"
expect_json_response actor

status="$(request inbox \
  --request POST \
  --header 'Accept: application/activity+json' \
  --header 'Content-Type: application/activity+json' \
  --data '{}' \
  "$WEB_ORIGIN/ap/users/__smoke_missing__/inbox")"
expect_status "$status" 404 "ActivityPub inbox"
expect_json_response inbox

echo "Mention post-deploy smoke checks passed."
