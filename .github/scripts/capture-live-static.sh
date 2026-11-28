#!/usr/bin/env bash
# Capture the release that is LIVE right now, so the next one can carry it.
#
# `carry-previous-static.sh` ships the previous release's hashed files beside the
# new ones. Its source used to be a build artifact uploaded after a release's
# production smoke passed. That source cannot bootstrap: when no release has
# passed the smoke since the artifact existed, there is nothing to download, the
# release ships only its own files, and the smoke then finds the OLD document
# (still served by a node mid-rollout) naming chunks the new version has not got.
# Measured on runs 38672618926 and 38678276819: "No previous release output to
# carry forward", then `global-8ee036….css returned HTML` for the old release's
# stylesheet, 11 retries, rollback, and the same again on every later attempt.
#
# The live origin is the one source that is always the release that must keep
# working, with nothing to age out, expire or be missing. It is read exactly the
# way a browser reads it: the document names the entry chunks, and every script
# names the lazy chunks it can load as full `_expo/static/...` paths, so the set
# is closed by following names until no new one appears.
#
# Best-effort by design, like the carry itself: an unreachable origin or a first
# ever deploy leaves the output empty and the release ships only its own files.
#
# Usage: capture-live-static.sh <origin> <output-dir>
#   output-dir is laid out as `_expo/static` is (js/web/…, css/…).
#   WEB_SHELL_ACCESS_KEY, when set, is sent as the shell Worker's access header.
set -uo pipefail

origin="${1:?usage: capture-live-static.sh <origin> <output-dir>}"
out="${2:?usage: capture-live-static.sh <origin> <output-dir>}"
key="${WEB_SHELL_ACCESS_KEY:-}"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
rm -rf -- "$out"
mkdir -p "$out"

fetch() {
  local auth=()
  if [[ -n "$key" ]]; then
    auth=(--header "X-Mention-Shell-Key: $key")
  fi
  curl --silent --show-error --max-time 30 --retry 3 --retry-delay 2 --retry-all-errors \
    --max-redirs 0 "${auth[@]}" --write-out '%{http_code} %{content_type}' "$@"
}

names() {
  grep -oE '_expo/static/[A-Za-z0-9_./~@-]+\.(js|css)' "$1" || true
}

if ! meta="$(fetch --output "$work/document" "$origin/")" || [[ "$meta" != 200* ]]; then
  echo "::notice::Could not read the live document (${meta:-no answer}); this release ships only its own assets."
  exit 0
fi

: >"$work/queue"
: >"$work/seen"
names "$work/document" >>"$work/queue"
fetched=0
skipped=0

while :; do
  next="$(sort -u "$work/queue" | comm -23 - "$work/seen" | head -n 1)"
  [[ -n "$next" ]] || break
  echo "$next" >>"$work/seen"
  sort -u "$work/seen" -o "$work/seen"
  target="$out/${next#_expo/static/}"
  mkdir -p "$(dirname "$target")"
  meta="$(fetch --output "$target" "$origin/$next")" || meta=""
  # A name the live release itself cannot serve is not something to carry: the
  # SPA fallback answers HTML for it, and shipping that would invent a file.
  if [[ "$meta" != 200* || "$meta" == *text/html* ]]; then
    rm -f "$target"
    skipped=$((skipped + 1))
    continue
  fi
  fetched=$((fetched + 1))
  if [[ "$next" == *.js ]]; then
    names "$target" >>"$work/queue"
  fi
done

echo "Captured $fetched file(s) of the live release ($skipped named but not served)."
