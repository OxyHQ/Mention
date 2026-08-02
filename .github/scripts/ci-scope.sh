#!/usr/bin/env bash
set -euo pipefail

# Decide whether one CI test leg has to run for this revision.
#
# Same idea as deployment-scope.sh, different base: a deploy compares against
# what it last shipped, while a check compares against the revision it is being
# merged into. The base is resolved by the caller and handed in through
# CI_SCOPE_BASE, because a pull request and a push to main derive it from
# different halves of the event payload.
#
# The bias throughout is towards running: an unreadable base, an empty diff and
# any path the rules below do not recognise all mean "run everything". A filter
# that skips a leg it should have run reports green on a break, which is worth
# far more than the minutes it saves.

leg="${1:-}"
base="${CI_SCOPE_BASE:-}"
sha="${CI_SCOPE_SHA:-HEAD}"

case "$leg" in
  shared-types | backend | frontend | mcp) ;;
  *)
    echo "usage: ci-scope.sh <shared-types|backend|frontend|mcp>" >&2
    exit 2
    ;;
esac

emit() {
  echo "leg=$leg run=$1 ($2)"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "run=$1" >>"$GITHUB_OUTPUT"
  fi
  exit 0
}

if [[ -z "$base" ]] || ! git rev-parse --verify --quiet "${base}^{commit}" >/dev/null; then
  emit true "no readable base revision, so nothing can be ruled out"
fi
git cat-file -e "${sha}^{commit}"

changed="$(git diff --name-status -M "$base" "$sha")"
if [[ -z "$changed" ]]; then
  emit true "empty diff against $base"
fi

run=false
reason=

# Record that a path reaches this leg. `all` reaches every leg.
want() {
  if [[ "$1" == "$leg" || "$1" == all ]]; then
    run=true
    reason="$2"
  fi
}

while IFS=$'\t' read -r status first second; do
  [[ -n "$status" ]] || continue

  # packages/backend/src/__tests__/agentsMdReferences.test.ts asserts over
  # `git ls-files` for the WHOLE repo: every path AGENTS.md names must still
  # exist, and the paths it lists as deliberately unresolvable must not start
  # existing. Any addition, deletion or rename ANYWHERE can therefore break the
  # backend suite from outside packages/backend — exactly the hole a naive
  # per-package filter opens. A modification cannot: it moves no path.
  if [[ "$status" != M ]]; then
    want backend "$status $first changes the tracked-file set"
  fi

  # A rename reports both sides, and a path that stopped existing matters as
  # much as the one that replaced it.
  paths=("$first")
  if [[ -n "${second:-}" ]]; then
    paths+=("$second")
  fi

  for path in "${paths[@]}"; do
    case "$path" in
      # Read by the test above, so its CONTENT decides a backend assertion.
      AGENTS.md) want backend 'AGENTS.md is read by the backend suite' ;;
      # Prose nothing reads. A doc that moves is caught by the status rule above.
      docs/*) ;;
      packages/shared-types/*) want all "$path is a dependency of every package" ;;
      packages/backend/*) want backend "$path" ;;
      packages/frontend/*) want frontend "$path" ;;
      packages/mcp/*) want mcp "$path" ;;
      # After the package rules, so packages/frontend/docs/x.md is frontend's.
      *.md) ;;
      # Workspace manifests, the lockfile, tsconfig, patches, .github, and every
      # path not named above: assume it reaches everywhere until someone proves
      # otherwise right here.
      *) want all "$path is not scoped to one package" ;;
    esac
  done

  if [[ "$run" == true ]]; then
    break
  fi
done <<<"$changed"

if [[ "$run" == true ]]; then
  emit true "$reason"
fi
emit false "nothing between $base and $sha reaches this package"
