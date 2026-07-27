#!/usr/bin/env bash
set -euo pipefail

target="${1:-}"
sha="${DEPLOY_SHA:-HEAD}"

case "$target" in
  backend | frontend | mcp) ;;
  *)
    echo "usage: deployment-scope.sh <backend|frontend|mcp>" >&2
    exit 2
    ;;
esac

git cat-file -e "${sha}^{commit}"
changed_output="$(
  git diff-tree \
    --root \
    --no-commit-id \
    --name-only \
    -r \
    -m \
    "$sha" |
    sort -u
)"
mapfile -t changed_paths <<<"$changed_output"

deploy=false
for path in "${changed_paths[@]}"; do
  case "$target:$path" in
    backend:packages/backend/* | \
    backend:packages/shared-types/* | \
    backend:.github/scripts/deploy-ecs-image.sh | \
    backend:.github/scripts/audit-runtime-image.sh | \
    backend:.github/scripts/require-current-main.sh | \
    backend:.github/scripts/smoke-mention.sh | \
    mcp:packages/mcp/* | \
    mcp:packages/shared-types/* | \
    mcp:.github/scripts/deploy-ecs-image.sh | \
    mcp:.github/scripts/audit-runtime-image.sh | \
    mcp:.github/scripts/require-current-main.sh | \
    mcp:.github/scripts/smoke-mcp.sh | \
    frontend:packages/frontend/* | \
    frontend:packages/shared-types/* | \
    frontend:.github/scripts/require-current-main.sh | \
    frontend:.github/scripts/smoke-frontend.sh | \
    frontend:.github/scripts/validate-frontend-static-output.mjs)
      deploy=true
      break
      ;;
    backend:package.json | backend:bun.lock | backend:bunfig.toml | backend:tsconfig.json | backend:.dockerignore | backend:patches/* | \
    mcp:package.json | mcp:bun.lock | mcp:bunfig.toml | mcp:tsconfig.json | mcp:.dockerignore | mcp:patches/* | \
    frontend:package.json | frontend:bun.lock | frontend:bunfig.toml | frontend:tsconfig.json | frontend:patches/*)
      deploy=true
      break
      ;;
  esac
done

echo "target=$target deploy=$deploy"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "deploy=$deploy" >>"$GITHUB_OUTPUT"
fi
