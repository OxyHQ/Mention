#!/usr/bin/env bash

set -euo pipefail

MCP_ORIGIN="${MCP_ORIGIN:-https://mcp.mention.earth}"

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

curl \
  --fail \
  --silent \
  --show-error \
  --max-time 20 \
  --retry 8 \
  --retry-delay 5 \
  --retry-all-errors \
  "$MCP_ORIGIN/health" \
  >/dev/null

status="$(curl \
  --silent \
  --show-error \
  --max-time 20 \
  --retry 8 \
  --retry-delay 5 \
  --retry-all-errors \
  --max-redirs 0 \
  --dump-header "$smoke_dir/auth.headers" \
  --output "$smoke_dir/auth.body" \
  --write-out '%{http_code}' \
  "$MCP_ORIGIN/")"

if [[ "$status" != "401" ]]; then
  echo "::error::MCP unauthenticated root returned HTTP $status (expected 401)."
  exit 1
fi
if ! grep -Eiq '^www-authenticate: *Bearer .*resource_metadata=' \
  "$smoke_dir/auth.headers"; then
  echo "::error::MCP 401 is missing the Bearer resource_metadata challenge."
  exit 1
fi

echo "Mention MCP post-deploy smoke checks passed."
