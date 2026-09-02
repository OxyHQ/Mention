#!/usr/bin/env bash

set -euo pipefail

MCP_ORIGIN="${MCP_ORIGIN:-https://mcp.mention.earth}"
OXY_OAUTH_ORIGIN="${OXY_OAUTH_ORIGIN:-https://api.oxy.so}"
OXY_AUTHORIZATION_ENDPOINT="${OXY_AUTHORIZATION_ENDPOINT:-https://auth.oxy.so/authorize}"

MCP_ORIGIN="${MCP_ORIGIN%/}"
OXY_OAUTH_ORIGIN="${OXY_OAUTH_ORIGIN%/}"
OXY_AUTHORIZATION_ENDPOINT="${OXY_AUTHORIZATION_ENDPOINT%/}"
RESOURCE_METADATA_URL="$MCP_ORIGIN/.well-known/oauth-protected-resource"

# The central authorization server is outside this deployment's ownership. A
# failure there must page and fail the workflow, but rolling Mention back cannot
# repair it. deploy-ecs-image.sh reserves 75 for exactly that outcome.
readonly EXTERNAL_DEPENDENCY_EXIT=75

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

fetch_json() {
  local output_file="$1"
  local url="$2"
  curl \
    --fail \
    --silent \
    --show-error \
    --max-time 20 \
    --retry 8 \
    --retry-delay 5 \
    --retry-all-errors \
    --output "$output_file" \
    "$url"
}

capture_response() {
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

fetch_json "$smoke_dir/health.json" "$MCP_ORIGIN/health"
if ! jq -e \
  --arg resource "$MCP_ORIGIN" \
  '.status == "ok" and .server == "mention-mcp" and .url == $resource' \
  "$smoke_dir/health.json" >/dev/null; then
  echo "::error::Mention MCP health response does not identify the expected service and resource."
  exit 1
fi

if ! fetch_json \
  "$smoke_dir/authorization-server.json" \
  "$OXY_OAUTH_ORIGIN/.well-known/oauth-authorization-server"; then
  echo "::error::The external Oxy authorization server is unavailable; rolling Mention back cannot repair it."
  exit "$EXTERNAL_DEPENDENCY_EXIT"
fi

if ! jq -e \
  --arg issuer "$OXY_OAUTH_ORIGIN" \
  --arg authorization_endpoint "$OXY_AUTHORIZATION_ENDPOINT" \
  '
    .issuer == $issuer and
    .authorization_endpoint == $authorization_endpoint and
    .token_endpoint == ($issuer + "/auth/mcp/oauth/token") and
    .registration_endpoint == ($issuer + "/auth/mcp/oauth/register") and
    .revocation_endpoint == ($issuer + "/auth/mcp/oauth/revoke") and
    .jwks_uri == ($issuer + "/auth/mcp/oauth/jwks") and
    (.grant_types_supported | index("authorization_code") != null) and
    (.grant_types_supported | index("refresh_token") != null) and
    (.code_challenge_methods_supported == ["S256"]) and
    .resource_parameter_supported == true
  ' "$smoke_dir/authorization-server.json" >/dev/null; then
  echo "::error::The external Oxy authorization-server metadata is invalid; rolling Mention back cannot repair it."
  exit "$EXTERNAL_DEPENDENCY_EXIT"
fi

fetch_json "$smoke_dir/protected-resource.json" "$RESOURCE_METADATA_URL"
if ! jq -e \
  --arg resource "$MCP_ORIGIN" \
  --arg issuer "$OXY_OAUTH_ORIGIN" \
  '
    .resource == $resource and
    .authorization_servers == [$issuer] and
    .bearer_methods_supported == ["header"] and
    ((.scopes_supported | sort) == [
      "social.accounts.link",
      "social.accounts.read",
      "social.accounts.switch",
      "social.collaboration.manage",
      "social.follow",
      "social.interact",
      "social.lists.create",
      "social.lists.delete",
      "social.lists.read",
      "social.lists.update",
      "social.media.create",
      "social.media.read",
      "social.notifications.manage",
      "social.notifications.read",
      "social.polls.vote",
      "social.posts.delete",
      "social.posts.publish",
      "social.posts.read",
      "social.posts.save",
      "social.posts.update",
      "social.profile.read",
      "social.read",
      "social.search",
      "social.starter_packs.create",
      "social.starter_packs.delete",
      "social.starter_packs.read",
      "social.starter_packs.update"
    ])
  ' "$smoke_dir/protected-resource.json" >/dev/null; then
  echo "::error::Mention protected-resource metadata does not match its canonical catalog and OAuth authority."
  exit 1
fi

status="$(capture_response auth "$MCP_ORIGIN/mcp")"

if [[ "$status" != "401" ]]; then
  echo "::error::Mention MCP unauthenticated endpoint returned HTTP $status (expected 401)."
  exit 1
fi
if ! tr -d '\r' <"$smoke_dir/auth.headers" \
  | grep -i '^www-authenticate: *Bearer ' \
  | grep -Fqi "resource_metadata=\"$RESOURCE_METADATA_URL\""; then
  echo "::error::Mention MCP 401 is missing its exact protected-resource metadata challenge."
  exit 1
fi

invalid_status="$(capture_response \
  invalid-token \
  --request POST \
  --header 'Authorization: Bearer eyJhbGciOiJFZERTQSJ9.e30.invalid' \
  --header 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":"smoke","method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mention-production-smoke","version":"1.0.0"}}}' \
  "$MCP_ORIGIN/mcp")"
if [[ "$invalid_status" != "401" ]]; then
  echo "::error::Mention MCP accepted or mishandled an inactive central token with HTTP $invalid_status (expected 401)."
  exit 1
fi
if ! tr -d '\r' <"$smoke_dir/invalid-token.headers" \
  | grep -i '^www-authenticate: *Bearer ' \
  | grep -Fqi "resource_metadata=\"$RESOURCE_METADATA_URL\""; then
  echo "::error::Mention MCP inactive-token response is missing its exact OAuth discovery challenge."
  exit 1
fi

echo "Mention MCP and central OAuth post-deploy smoke checks passed."
