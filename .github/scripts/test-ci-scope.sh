#!/usr/bin/env bash

set -euo pipefail

# ci-scope.sh decides which test legs a revision can skip, so a wrong answer is
# a green CI over a break. Every case below therefore asserts the decision for
# ALL FOUR legs, not just the interesting one — a rule that leaks into a
# neighbouring leg is the same bug as one that skips too much.

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
scope_script="$repository_root/.github/scripts/ci-scope.sh"
test_directory="$(mktemp -d)"
temporary_root="$(realpath "${TMPDIR:-/tmp}")"
test_directory="$(realpath "$test_directory")"

cleanup_test_directory() {
  if [[ "$test_directory" == "$temporary_root/"* && -d "$test_directory" ]]; then
    rm -rf -- "$test_directory"
  else
    echo "Refusing to remove unexpected test directory: $test_directory" >&2
  fi
}
trap cleanup_test_directory EXIT

failures=0
cases_run=0

# A throwaway repository with one commit of scaffolding, so every case can diff
# a second commit against it.
fixture_repository() {
  local directory="$test_directory/repo-$1"
  rm -rf -- "$directory"
  mkdir -p "$directory"
  (
    cd "$directory"
    git init --quiet
    git config user.email ci-scope@test.invalid
    git config user.name 'ci scope test'
    mkdir -p packages/backend packages/frontend packages/mcp packages/shared-types docs .github/workflows
    echo 'backend' >packages/backend/index.ts
    echo 'frontend' >packages/frontend/index.tsx
    echo 'mcp' >packages/mcp/index.ts
    echo 'types' >packages/shared-types/index.ts
    echo 'agents' >AGENTS.md
    echo 'readme' >README.md
    echo 'doc' >docs/guide.md
    echo 'lock' >bun.lock
    echo 'workflow' >.github/workflows/ci.yml
    git add -A
    git commit --quiet -m base
  )
  echo "$directory"
}

# expect <name> <repo> <shared-types> <backend> <frontend> <mcp>
expect() {
  local name="$1" repository="$2"
  shift 2
  local legs=(shared-types backend frontend mcp)
  local index=0
  cases_run=$((cases_run + 1))
  for leg in "${legs[@]}"; do
    local wanted="${1}"
    shift
    local output actual
    output="$(cd "$repository" && CI_SCOPE_BASE=HEAD~1 CI_SCOPE_SHA=HEAD bash "$scope_script" "$leg")"
    actual="${output#*run=}"
    actual="${actual%% *}"
    if [[ "$actual" != "$wanted" ]]; then
      echo "FAIL [$name] $leg: expected run=$wanted, got: $output" >&2
      failures=$((failures + 1))
    fi
    index=$((index + 1))
  done
}

commit_in() {
  local directory="$1"
  shift
  (cd "$directory" && "$@" && git add -A && git commit --quiet -m change)
}

#                                                        types backend frontend mcp
repository="$(fixture_repository frontend-only)"
commit_in "$repository" bash -c "echo more >>packages/frontend/index.tsx"
expect 'a frontend edit runs only the frontend' "$repository" false false true false

repository="$(fixture_repository backend-only)"
commit_in "$repository" bash -c "echo more >>packages/backend/index.ts"
expect 'a backend edit runs only the backend' "$repository" false true false false

repository="$(fixture_repository mcp-only)"
commit_in "$repository" bash -c "echo more >>packages/mcp/index.ts"
expect 'an mcp edit runs only mcp' "$repository" false false false true

repository="$(fixture_repository shared-types)"
commit_in "$repository" bash -c "echo more >>packages/shared-types/index.ts"
expect 'shared-types runs every leg' "$repository" true true true true

repository="$(fixture_repository docs-only)"
commit_in "$repository" bash -c "echo more >>docs/guide.md"
expect 'a docs edit runs nothing' "$repository" false false false false

repository="$(fixture_repository root-readme)"
commit_in "$repository" bash -c "echo more >>README.md"
expect 'a root README edit runs nothing' "$repository" false false false false

# AGENTS.md is read by packages/backend/src/__tests__/agentsMdReferences.test.ts.
repository="$(fixture_repository agents-md)"
commit_in "$repository" bash -c "echo 'see \`packages/backend/index.ts\`' >>AGENTS.md"
expect 'an AGENTS.md edit runs the backend' "$repository" false true false false

repository="$(fixture_repository lockfile)"
commit_in "$repository" bash -c "echo more >>bun.lock"
expect 'the lockfile runs every leg' "$repository" true true true true

repository="$(fixture_repository workflow)"
commit_in "$repository" bash -c "echo more >>.github/workflows/ci.yml"
expect 'a workflow edit runs every leg' "$repository" true true true true

# The tracked-file set decides two of that test's three assertions, so a path
# that appears, vanishes or moves anywhere reaches the backend suite.
repository="$(fixture_repository frontend-add)"
commit_in "$repository" bash -c "echo new >packages/frontend/added.tsx"
expect 'a frontend ADDITION also runs the backend' "$repository" false true true false

repository="$(fixture_repository frontend-delete)"
commit_in "$repository" rm packages/frontend/index.tsx
expect 'a frontend DELETION also runs the backend' "$repository" false true true false

repository="$(fixture_repository docs-rename)"
commit_in "$repository" git mv docs/guide.md docs/renamed.md
expect 'a docs RENAME still runs the backend' "$repository" false true false false

repository="$(fixture_repository unknown-path)"
commit_in "$repository" bash -c "echo x >>packages/frontend/index.tsx && echo y >Makefile"
expect 'an unrecognised path runs every leg' "$repository" true true true true

# Fallbacks. Each of these means "we could not tell", which must never be "skip".
repository="$(fixture_repository fallbacks)"
commit_in "$repository" bash -c "echo more >>packages/frontend/index.tsx"
for leg in shared-types backend frontend mcp; do
  cases_run=$((cases_run + 1))
  for description in 'an empty base' 'an unresolvable base'; do
    case "$description" in
      'an empty base') base= ;;
      *) base=0000000000000000000000000000000000000000 ;;
    esac
    output="$(cd "$repository" && CI_SCOPE_BASE="$base" bash "$scope_script" "$leg")"
    if [[ "$output" != *'run=true'* ]]; then
      echo "FAIL [$description] $leg: expected run=true, got: $output" >&2
      failures=$((failures + 1))
    fi
  done
  output="$(cd "$repository" && CI_SCOPE_BASE=HEAD CI_SCOPE_SHA=HEAD bash "$scope_script" "$leg")"
  if [[ "$output" != *'run=true'* ]]; then
    echo "FAIL [an empty diff] $leg: expected run=true, got: $output" >&2
    failures=$((failures + 1))
  fi
done

cases_run=$((cases_run + 1))
if (cd "$repository" && bash "$scope_script" nonsense >/dev/null 2>&1); then
  echo 'FAIL an unknown leg name was accepted' >&2
  failures=$((failures + 1))
fi

# A vacuity floor: a rewrite that stopped running the cases would otherwise
# report a clean pass.
if ((cases_run < 15)); then
  echo "FAIL only $cases_run cases ran; the suite is not exercising ci-scope.sh" >&2
  failures=$((failures + 1))
fi

if ((failures > 0)); then
  echo "ci-scope.sh: $failures assertion(s) failed across $cases_run cases" >&2
  exit 1
fi

echo "ci-scope.sh: $cases_run cases passed"
