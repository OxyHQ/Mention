#!/usr/bin/env bash

# Decide which of the two release paths owns this commit, so exactly one of
# them deploys it.
#
# Each deploy workflow is triggered twice for every commit on main:
#
#   * `push` — the moment the commit lands. With the merge queue on, a commit
#     that lands through it is BYTE-FOR-BYTE the tree CI already tested in its
#     `merge_group` run: the queue builds the merge commit on a
#     `gh-readonly-queue/main/...` branch, runs CI against it, and fast-forwards
#     main to that same SHA only once `CI complete` is green. Re-running CI on
#     push would re-test a tree already proven, and used to cost every release
#     a serial ~8-10 minutes before the deploy could even start.
#
#   * `workflow_run` of CI on push — the path every release took before the
#     queue, kept as the FALLBACK for commits that did not come through it: an
#     admin bypass, a direct push, the window before the ruleset is enabled.
#
# The rule is one predicate evaluated identically on both paths:
#
#     VERIFIED = this exact SHA has a CI (`.github/workflows/ci.yml`) run from
#                the `merge_group` event, in this repository, that concluded
#                `success`, and whose `CI complete` job concluded `success`.
#
#     push          + VERIFIED     -> release  (the merge-queue path)
#     push          + not VERIFIED -> skip     (the fallback will judge it)
#     workflow_run  + VERIFIED     -> skip     (the push path already owns it)
#     workflow_run  + not VERIFIED -> release  (CI on push passed; old path)
#
# The predicate cannot change between the two evaluations: the queue refuses to
# merge until that `merge_group` run is green, so by the time the SHA is on main
# its answer is final. That is what makes the paths mutually exclusive rather
# than merely unlikely to overlap — and the `deployed/<target>` marker would
# turn a second release of the same SHA into an empty scope anyway.
#
# FAIL CLOSED, loudly. A commit that is not VERIFIED is never released on the
# push path; it waits for its own full CI run. An API error is a red run, never
# a skip: a skip on a transient 502 would hand the commit to a fallback that
# then skips it as VERIFIED, and the release would be silently lost.
#
# Inputs: DEPLOY_SHA, GITHUB_REPOSITORY, GITHUB_EVENT_NAME (`push` or
# `workflow_run`), GH_TOKEN (needs `actions: read`), and on `workflow_run`,
# WORKFLOW_RUN_CONCLUSION. Output: `release=true|false` on $GITHUB_OUTPUT.

set -euo pipefail

: "${DEPLOY_SHA:?DEPLOY_SHA is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_EVENT_NAME:?GITHUB_EVENT_NAME is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required; a decision nobody can read is not a decision}"

ci_workflow_path='.github/workflows/ci.yml'
required_job='CI complete'

if [[ ! "$DEPLOY_SHA" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
  echo "::error::DEPLOY_SHA must be a full lowercase Git commit ID."
  exit 1
fi

case "$GITHUB_EVENT_NAME" in
  push) ;;
  workflow_run)
    # The job's `if:` already requires this. Restated so the script cannot be
    # reused somewhere that forgot to, and release a commit whose CI failed.
    if [[ "${WORKFLOW_RUN_CONCLUSION:-}" != success ]]; then
      echo "::error::workflow_run release requested for a CI run that concluded '${WORKFLOW_RUN_CONCLUSION:-}'."
      exit 1
    fi
    ;;
  *)
    echo "::error::release-provenance.sh only decides for push and workflow_run, not '$GITHUB_EVENT_NAME'."
    exit 1
    ;;
esac

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
  echo "Merge-queue verified: CI run $verified_run tested $DEPLOY_SHA in merge_group and '$required_job' passed."
else
  echo "Not merge-queue verified: no successful merge_group CI run with a green '$required_job' exists for $DEPLOY_SHA."
fi

release=false
case "$GITHUB_EVENT_NAME:${verified_run:+verified}" in
  push:verified)
    release=true
    ;;
  push:)
    echo "::notice::$DEPLOY_SHA did not come through the merge queue, so this push releases nothing. The CI run on push tests it, and its completion releases it."
    ;;
  workflow_run:verified)
    echo "::notice::$DEPLOY_SHA came through the merge queue, so the push-triggered run of this workflow owns its release. Nothing to do here."
    ;;
  workflow_run:)
    release=true
    ;;
esac

echo "release=$release" >>"$GITHUB_OUTPUT"
echo "event=$GITHUB_EVENT_NAME release=$release"
