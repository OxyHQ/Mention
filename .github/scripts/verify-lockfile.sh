#!/usr/bin/env bash
#
# Verifies that the committed bun.lock is exactly what bun produces from the
# base revision's lockfile and this revision's package.json manifests.
#
# Ported from bluesky-social/social-app 513a188a2 ("Add a GitHub Action verifying
# lockfile against base", MIT (c) 2023-2026 Bluesky Social PBC), adapted from
# yarn to bun. Two deliberate deviations from that snippet: the corrective diff
# is printed forwards rather than reversed (`git diff -R` shows how to undo the
# regenerated lockfile, not how to adopt it), and the diff goes to the step
# summary, because this runs on `pull_request` with `contents: read` and forks
# get no token that could post a comment.
#
# Why this and not `bun install --frozen-lockfile`: bun 1.3.14 fails that flag
# non-deterministically on a clean, unmodified HEAD (configVersion churn), so a
# failure there proves nothing and gets learned-around. This compares one
# installer's output against the committed file instead, which makes "this
# lockfile is what a clean resolve produces" a property of the commit rather
# than of whoever's machine wrote it.
#
# Restoring the BASE lockfile first is load-bearing, not ceremony: bun keeps a
# pin that still satisfies its range, so resolving from the base lockfile is
# stable, while resolving from no lockfile at all walks every caret range up to
# whatever published most recently (measured on this repo: 212 insertions, 488
# deletions against a lockfile that was correct).
set -euo pipefail

base_revision="${1:?usage: verify-lockfile.sh <base-revision>}"

if ! git cat-file -e "${base_revision}:bun.lock" 2>/dev/null; then
  echo "::error::cannot read bun.lock at ${base_revision}; this job needs actions/checkout with fetch-depth: 0"
  exit 1
fi

git show "${base_revision}:bun.lock" >bun.lock

# --lockfile-only resolves and writes the lockfile without downloading or
# linking any package, so no lifecycle script runs. Verified to produce a
# byte-identical lockfile to a full `bun install` on this repo.
bun install --lockfile-only

if git diff --quiet --exit-code -- bun.lock; then
  echo "bun.lock is what bun resolves from ${base_revision} plus this revision's manifests."
  exit 0
fi

echo "::error file=bun.lock::bun.lock is not what \`bun install\` produces from ${base_revision}'s lockfile and this revision's package.json files. Run \`bun install\` and commit bun.lock in the same commit as the package.json change. The corrective diff is in the job summary."

{
  echo "### \`bun.lock\` does not match a clean resolve"
  echo
  echo "Resolving \`${base_revision}\`'s \`bun.lock\` against this revision's \`package.json\` manifests produced something other than the committed lockfile."
  echo
  echo "Fix it by running \`bun install\` and committing \`bun.lock\`, or apply this diff directly:"
  echo
  echo '```diff'
  git --no-pager diff -- bun.lock
  echo '```'
} >>"${GITHUB_STEP_SUMMARY:-/dev/stdout}"

git --no-pager diff --stat -- bun.lock
exit 1
