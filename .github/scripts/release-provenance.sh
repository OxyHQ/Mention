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
# The rule is one predicate (merge-queue-verified.sh) evaluated identically on
# both paths:
#
#     VERIFIED = this exact SHA passed `CI complete` in a merge_group run.
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

# The predicate lives in merge-queue-verified.sh, shared with CI's own push
# fast path. Run WITHOUT $GITHUB_OUTPUT so it writes nothing of its own there,
# and in an assignment so its API failure trips `set -e` — red, never a skip.
verified_run="$(env -u GITHUB_OUTPUT bash "$(dirname "${BASH_SOURCE[0]}")/merge-queue-verified.sh")"

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
