#!/usr/bin/env bash

# Find the production image the merge queue already built for this commit.
#
# main moves only through the merge queue (squash, one entry built at a time),
# and the commit a `merge_group` run tests is the commit main is fast-forwarded
# to, SHA for SHA. .github/workflows/merge-queue-image.yml builds the image from
# that commit, in parallel with CI, and pushes it as `<repo>:mq-<sha>`. So on a
# push to main the image for `$SHA` usually exists already, and the deploy rolls
# it out instead of rebuilding it.
#
# The tag alone is not trusted. The image is used only when a merge_group run
# of THAT workflow file, in THIS repository, for exactly this SHA, concluded
# `success` — the run that pushed it. If that run is still going (the queue can
# land the commit while the image job waits for a runner), this waits for it,
# up to WAIT_SECS.
#
# Every other outcome — no queue run (a manual dispatch, a commit that did not
# come through the queue), a failed or cancelled run, a run that decided this
# commit deploys nothing, the tag missing, an API error, the wait running out —
# prints `digest=` (empty) and exits 0: the deploy then builds the image itself,
# exactly as it always did. Nothing here can make a deploy use an image that was
# not built from this commit; the worst it can do is make one build again.
#
# Inputs:  REPOSITORY (e.g. oxy/mention), SHA, GITHUB_REPOSITORY, GH_TOKEN
#          (`actions: read`), QUEUE_WORKFLOW (default merge-queue-image.yml),
#          WAIT_SECS (default 1200), POLL_SECS (default 20).
# Output:  `digest=<sha256:...|empty>` on stdout and in $GITHUB_OUTPUT.

set -euo pipefail

: "${REPOSITORY:?REPOSITORY is required}"
: "${SHA:?SHA is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
QUEUE_WORKFLOW="${QUEUE_WORKFLOW:-merge-queue-image.yml}"
WAIT_SECS="${WAIT_SECS:-1200}"
POLL_SECS="${POLL_SECS:-20}"

emit() {
  echo "digest=$1"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "digest=$1" >>"$GITHUB_OUTPUT"
  fi
  exit 0
}

build_instead() {
  echo "::notice::No merge-queue image for $SHA ($1); building it here." >&2
  emit ""
}

if [[ ! "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  build_instead "SHA is not a full commit id"
fi

# The merge_group runs of the image workflow for exactly this commit, as
# `<status> <conclusion>` lines. Addressed by file, and filtered by repository
# and path as well, so no other workflow and no fork can vouch for an image.
queue_runs() {
  gh api "repos/$GITHUB_REPOSITORY/actions/workflows/$QUEUE_WORKFLOW/runs?head_sha=$SHA&event=merge_group&per_page=20" |
    jq -r \
      --arg sha "$SHA" \
      --arg repo "$GITHUB_REPOSITORY" \
      --arg path ".github/workflows/$QUEUE_WORKFLOW" \
      '.workflow_runs[]
        | select(.head_sha == $sha
            and .event == "merge_group"
            and .head_repository.full_name == $repo
            and (.path == $path or (.path | startswith($path + "@"))))
        | "\(.status) \(.conclusion // "none")"'
}

deadline=$((SECONDS + WAIT_SECS))
while :; do
  if ! runs="$(queue_runs)"; then
    build_instead "the GitHub API did not answer for the queue image run"
  fi
  if [[ -z "$runs" ]]; then
    build_instead "no merge_group run of $QUEUE_WORKFLOW exists for it"
  fi
  if grep -q '^completed success$' <<<"$runs"; then
    break
  fi
  if ! grep -qv '^completed ' <<<"$runs"; then
    build_instead "its queue image run did not succeed: $(tr '\n' ' ' <<<"$runs")"
  fi
  if ((SECONDS >= deadline)); then
    build_instead "its queue image run was still going after ${WAIT_SECS}s"
  fi
  echo "Waiting for the queue image run for $SHA: $(tr '\n' ' ' <<<"$runs")" >&2
  sleep "$POLL_SECS"
done

# A successful run that built nothing (the commit changes nothing this deploy
# ships, but the deploy runs anyway, e.g. dispatched by hand) leaves no tag.
if ! found="$(aws ecr batch-get-image \
  --repository-name "$REPOSITORY" \
  --image-ids "imageTag=mq-$SHA" \
  --accepted-media-types \
  application/vnd.oci.image.index.v1+json \
  application/vnd.docker.distribution.manifest.list.v2+json \
  application/vnd.oci.image.manifest.v1+json \
  application/vnd.docker.distribution.manifest.v2+json \
  --output json)"; then
  build_instead "ECR did not answer for $REPOSITORY:mq-$SHA"
fi
digest="$(jq -r '.images[0].imageId.imageDigest // empty' <<<"$found")"
if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  build_instead "$REPOSITORY:mq-$SHA is not in ECR"
fi

echo "Reusing the merge-queue image $REPOSITORY:mq-$SHA -> $digest" >&2
emit "$digest"
