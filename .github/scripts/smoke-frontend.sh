#!/usr/bin/env bash

set -euo pipefail

WEB_ORIGIN="${WEB_ORIGIN:-https://mention.earth}"
# Set ONLY when smoking the shell Worker directly. That origin serves nothing
# without this key (`packages/frontend/worker/index.js`), so an unset value here
# turns every check below into an assertion about a 403 page. The apex and the
# Pages preview need no key and must not be given one.
WEB_SHELL_ACCESS_KEY="${WEB_SHELL_ACCESS_KEY:-}"
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
  local auth=()
  if [[ -n "$WEB_SHELL_ACCESS_KEY" ]]; then
    auth=(--header "X-Mention-Shell-Key: $WEB_SHELL_ACCESS_KEY")
  fi
  curl \
    --silent \
    --show-error \
    --max-time 20 \
    --retry 8 \
    --retry-delay 5 \
    --retry-all-errors \
    --max-redirs 0 \
    "${auth[@]}" \
    --dump-header "$smoke_dir/$name.headers" \
    --output "$smoke_dir/$name.body" \
    --write-out '%{http_code}' \
    "$@"
}

status="$(request web-shell "$WEB_ORIGIN/")"
if [[ "$status" != "200" ]]; then
  echo "::error::Web shell returned HTTP $status (expected 200)."
  exit 1
fi
if ! grep -Eiq '^cache-control:.*(no-cache|no-store|max-age=0|must-revalidate)' \
  "$smoke_dir/web-shell.headers"; then
  echo "::error::Web shell is missing revalidation-oriented cache headers."
  exit 1
fi

# The document is a promise that every chunk it names exists. Checking the first
# script is not checking the promise: a release that lost `__common` still
# passed while its entry bundle was fine, and the app was blank. So every
# `/_expo/static/` script and stylesheet the served document names is fetched.
#
# And once is not enough. The document is served through layers that may each
# hold a different release for a while after a deploy (the backend's shell copy,
# the edge), so a single request can land on the good one. The document is
# sampled several times and the union of what all the samples name is checked.
SMOKE_DOCUMENT_SAMPLES="${SMOKE_DOCUMENT_SAMPLES:-6}"
SMOKE_DOCUMENT_INTERVAL="${SMOKE_DOCUMENT_INTERVAL:-2}"
asset_list="$smoke_dir/assets.list"
: >"$asset_list"

for sample in $(seq 1 "$SMOKE_DOCUMENT_SAMPLES"); do
  if [[ "$sample" -gt 1 ]]; then
    sleep "$SMOKE_DOCUMENT_INTERVAL"
    # A fresh URL each time so nothing keyed on the URL answers for us.
    status="$(request "web-shell-$sample" "$WEB_ORIGIN/?smoke=$sample-$RANDOM")"
    if [[ "$status" != "200" ]]; then
      echo "::error::Web shell sample $sample returned HTTP $status (expected 200)."
      exit 1
    fi
    document="$smoke_dir/web-shell-$sample.body"
  else
    document="$smoke_dir/web-shell.body"
  fi
  grep -oE '/_expo/static/[^"'"'"'[:space:]<>]+\.(js|css)' "$document" >>"$asset_list" || true
done

sort -u "$asset_list" -o "$asset_list"
if [[ ! -s "$asset_list" ]]; then
  echo "::error::Web shell did not reference a hashed Expo JavaScript asset."
  exit 1
fi
if ! grep -q '\.js$' "$asset_list"; then
  echo "::error::Web shell did not reference a hashed Expo JavaScript asset."
  exit 1
fi

# A promotion reaches the edge's nodes one at a time, and every node answers
# from its own version. For a few seconds after a deploy, a document from a node
# that has the new version can name a chunk that a node still on the old version
# does not have. That node answers with the SPA fallback (`index.html`), which
# the apex proxy turns into a 404 for browsers. Measured twice on 2026-10-10:
# the gate read that window as a broken release and rolled it back, and a re-run
# of the same build passed.
#
# So a chunk the document names must be SERVED, and it is given the rollout to
# get there: a bounded wait while the answer is "not yet" (the fallback or a
# 404). Anything else fails at once, and so does a chunk still missing when the
# window closes. That is a release that does not ship its own assets.
SMOKE_ASSET_PROPAGATION_ATTEMPTS="${SMOKE_ASSET_PROPAGATION_ATTEMPTS:-12}"
SMOKE_ASSET_PROPAGATION_INTERVAL="${SMOKE_ASSET_PROPAGATION_INTERVAL:-5}"

index=0
while IFS= read -r asset_path; do
  index=$((index + 1))
  for attempt in $(seq 1 "$SMOKE_ASSET_PROPAGATION_ATTEMPTS"); do
    status="$(request "web-asset-$index" "$WEB_ORIGIN$asset_path")"
    not_yet=false
    if [[ "$status" == "404" ]]; then
      not_yet=true
    elif [[ "$status" == "200" ]] && grep -Eiq '^content-type: *text/html' "$smoke_dir/web-asset-$index.headers"; then
      not_yet=true
    fi
    if [[ "$not_yet" == false || "$attempt" -eq "$SMOKE_ASSET_PROPAGATION_ATTEMPTS" ]]; then
      break
    fi
    echo "$asset_path is not served yet (attempt $attempt/$SMOKE_ASSET_PROPAGATION_ATTEMPTS); waiting for the rollout to reach this node."
    sleep "$SMOKE_ASSET_PROPAGATION_INTERVAL"
  done
  if [[ "$status" != "200" ]]; then
    echo "::error::$asset_path returned HTTP $status (expected 200); the served document names a chunk this release does not have."
    exit 1
  fi
  if grep -Eiq '^content-type: *text/html' "$smoke_dir/web-asset-$index.headers"; then
    echo "::error::$asset_path returned HTML."
    exit 1
  fi
  if ! grep -Eiq '^cache-control: .*immutable' "$smoke_dir/web-asset-$index.headers"; then
    echo "::error::$asset_path is missing immutable caching."
    exit 1
  fi
done <"$asset_list"

echo "Checked $index hashed asset(s) named by $SMOKE_DOCUMENT_SAMPLES sample(s) of the document."
echo "Mention frontend post-deploy smoke checks passed."
