#!/usr/bin/env bash

set -euo pipefail

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
    --retry 8 \
    --retry-delay 5 \
    --retry-all-errors \
    --max-redirs 0 \
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

asset_path="$(grep -oE '/_expo/static/[^"[:space:]]+\.js' \
  "$smoke_dir/web-shell.body" | head -n 1 || true)"
if [[ -z "$asset_path" ]]; then
  echo "::error::Web shell did not reference a hashed Expo JavaScript asset."
  exit 1
fi

status="$(request web-asset "$WEB_ORIGIN$asset_path")"
if [[ "$status" != "200" ]]; then
  echo "::error::Web asset returned HTTP $status (expected 200)."
  exit 1
fi
if grep -Eiq '^content-type: *text/html' "$smoke_dir/web-asset.headers"; then
  echo "::error::Expo asset returned HTML."
  exit 1
fi
if ! grep -Eiq '^cache-control: .*immutable' "$smoke_dir/web-asset.headers"; then
  echo "::error::Hashed Expo asset is missing immutable caching."
  exit 1
fi

echo "Mention frontend post-deploy smoke checks passed."
