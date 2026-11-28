#!/usr/bin/env bash

set -euo pipefail

target="${1:-}"

case "$target" in
  backend | frontend | mcp) ;;
  *)
    echo "usage: record-deployment.sh <backend|frontend|mcp>" >&2
    exit 2
    ;;
esac

: "${DEPLOY_SHA:?DEPLOY_SHA is required}"

if [[ ! "$DEPLOY_SHA" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
  echo "::error::DEPLOY_SHA must be a full lowercase Git commit ID."
  exit 1
fi

git cat-file -e "${DEPLOY_SHA}^{commit}"

# deployment-scope.sh diffs the next candidate against this marker. Moving it
# only here, after a successful rollout, keeps a skipped or failed release
# recoverable: the change stays inside the next range instead of being dropped.
git push --force origin "${DEPLOY_SHA}:refs/tags/deployed/${target}"

echo "deployed/$target now points at $DEPLOY_SHA."
