#!/usr/bin/env bash

# Refuse to release a commit that is no longer the head of main.
#
# Two outcomes are possible when the candidate is stale, and which one a caller
# gets is its own choice:
#
#   * default: exit 1. The one-shot operations (`run-*.yml`) rely on this — for
#     them a stale SHA means an operator asked for something that has moved, and
#     a red run is the right answer.
#
#   * STALE_RELEASE=skip: exit 0 with `current=false` on $GITHUB_OUTPUT and a
#     notice. The three deploy workflows use this, because for them a stale
#     candidate is not a failure at all — main moved while the release was in
#     flight, and the release for the NEWER head carries this one's changes
#     (deployment-scope.sh diffs against the `deployed/<target>` marker, not the
#     previous commit). Measured before this mode existed: 8 of the last 27
#     frontend deploys and ~6 of 20 backend deploys ended red on exactly this,
#     every one of them a correct refusal, and the red hid the real failures
#     among them. The caller gates every later step on `current == 'true'`.
#
# What never changes between the two: a stale SHA is NEVER deployed, and a
# checked-out tree that is not DEPLOY_SHA is always a hard failure — that is an
# integrity fault, not a race. Skip mode also refuses to run without
# $GITHUB_OUTPUT: a skip nobody can read would let the caller carry on as though
# the candidate were current.
#
# On `current=true` the output is written in both modes, so a caller can gate on
# it either way.

set -euo pipefail

: "${DEPLOY_SHA:?DEPLOY_SHA is required}"
stale_release="${STALE_RELEASE:-fail}"

case "$stale_release" in
  fail) ;;
  skip)
    if [[ -z "${GITHUB_OUTPUT:-}" ]]; then
      echo "::error::STALE_RELEASE=skip needs GITHUB_OUTPUT; a skip nobody can read is not a skip."
      exit 1
    fi
    ;;
  *)
    echo "::error::STALE_RELEASE must be 'fail' or 'skip', not '$stale_release'."
    exit 1
    ;;
esac

if [[ ! "$DEPLOY_SHA" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
  echo "::error::DEPLOY_SHA must be a full lowercase Git commit ID."
  exit 1
fi

git fetch \
  --force \
  --no-tags \
  --prune \
  origin \
  '+refs/heads/main:refs/remotes/origin/main'

checked_out_sha="$(git rev-parse --verify 'HEAD^{commit}')"
origin_main_sha="$(git rev-parse --verify 'refs/remotes/origin/main^{commit}')"

if [[ "$checked_out_sha" != "$DEPLOY_SHA" ]]; then
  echo "::error::The checked-out commit does not match DEPLOY_SHA; refusing a production release."
  exit 1
fi

if [[ "$origin_main_sha" != "$DEPLOY_SHA" ]]; then
  if [[ "$stale_release" == skip ]]; then
    echo "current=false" >>"$GITHUB_OUTPUT"
    echo "::notice::Skipped a stale release: $DEPLOY_SHA is no longer the head of origin/main ($origin_main_sha). Nothing was deployed; the release of $origin_main_sha carries this commit's changes."
    exit 0
  fi
  echo "::error::Stale production release blocked: DEPLOY_SHA is no longer the exact head of origin/main."
  exit 1
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "current=true" >>"$GITHUB_OUTPUT"
fi
echo "Production candidate $DEPLOY_SHA is the current origin/main head."
