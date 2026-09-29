#!/usr/bin/env bash

# Answer ONE question: did this exact commit pass CI in the merge queue?
#
#     VERIFIED = this exact SHA has a CI (`.github/workflows/ci.yml`) run from
#                the `merge_group` event, in this repository, that concluded
#                `success`, and whose `CI complete` job concluded `success`.
#
# Two callers, one predicate, so they can never disagree about a commit:
#
#   * release-provenance.sh (the deploy workflows) — which release path owns
#     the commit;
#   * ci.yml on push to main — whether the commit's full suite already ran,
#     on the very tree now on main, so the push run can skip re-running it.
#
# Prints the verifying run id on stdout, or nothing when there is none. When
# $GITHUB_OUTPUT is set it also writes `verified=true|false` there.
#
# An API error EXITS NON-ZERO and prints nothing. That is not "not verified":
# each caller decides what an unanswerable question means for it, and neither
# may read it as a quiet no.
#
# Inputs: DEPLOY_SHA, GITHUB_REPOSITORY, GH_TOKEN (needs `actions: read`).

set -euo pipefail

: "${DEPLOY_SHA:?DEPLOY_SHA is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

ci_workflow_path='.github/workflows/ci.yml'
required_job='CI complete'

if [[ ! "$DEPLOY_SHA" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
  echo "::error::DEPLOY_SHA must be a full lowercase Git commit ID." >&2
  exit 1
fi

# Every successful merge_group run of ci.yml for exactly this SHA. The workflow
# is addressed by FILE, not by the display name "CI", so a second workflow that
# happens to be called CI cannot vouch for a commit.
candidate_runs="$(
  gh api --paginate \
    "repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml/runs?head_sha=$DEPLOY_SHA&event=merge_group&per_page=100" |
    jq -r \
      --arg sha "$DEPLOY_SHA" \
      --arg repo "$GITHUB_REPOSITORY" \
      --arg path "$ci_workflow_path" \
      '.workflow_runs[]
        | select(.head_sha == $sha
            and .event == "merge_group"
            and .conclusion == "success"
            and .head_repository.full_name == $repo
            and (.path == $path or (.path | startswith($path + "@"))))
        | .id'
)"

verified_run=
for run_id in $candidate_runs; do
  # The run's own conclusion is not trusted alone: `CI complete` is the job
  # branch protection requires, and it is the one that asserts every other job
  # ran on the path its event demands. Its latest attempt must be green.
  #
  # Fetched into a variable first, so an API failure trips `set -e` here instead
  # of reading as "not green" inside the `if` below.
  jobs="$(gh api --paginate "repos/$GITHUB_REPOSITORY/actions/runs/$run_id/jobs?filter=latest&per_page=100")"
  if jq -e -s --arg job "$required_job" \
    '[.[].jobs[] | select(.name == $job and .conclusion == "success")] | length > 0' <<<"$jobs" >/dev/null; then
    verified_run="$run_id"
    break
  fi
done

if [[ -n "$verified_run" ]]; then
  echo "Merge-queue verified: CI run $verified_run tested $DEPLOY_SHA in merge_group and '$required_job' passed." >&2
else
  echo "Not merge-queue verified: no successful merge_group CI run with a green '$required_job' exists for $DEPLOY_SHA." >&2
fi
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "verified=$([[ -n "$verified_run" ]] && echo true || echo false)" >>"$GITHUB_OUTPUT"
fi
echo "$verified_run"
