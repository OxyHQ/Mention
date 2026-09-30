#!/usr/bin/env bash

# Offline cases for resolve-queue-image.sh, with `gh` and `aws` replaced by
# stubs answering from fixtures. The one unacceptable outcome is a digest for
# an image the queue run for THIS commit did not build and succeed on; every
# doubtful case must come back empty (the deploy then builds, as before).

set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/resolve-queue-image.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0
sha=0123456789abcdef0123456789abcdef01234567
digest=sha256:1111111111111111111111111111111111111111111111111111111111111111

mkdir -p "$work/bin"
cat >"$work/bin/gh" <<'STUB'
#!/usr/bin/env bash
[[ -f "$FIXTURES/gh-fail" ]] && { echo "HTTP 502" >&2; exit 1; }
# Successive answers: runs.1.json, runs.2.json, ... then the last one forever.
n=$(( $(cat "$FIXTURES/gh-calls" 2>/dev/null || echo 0) + 1 ))
echo "$n" >"$FIXTURES/gh-calls"
file="$FIXTURES/runs.$n.json"
[[ -f "$file" ]] || file="$(ls "$FIXTURES"/runs.*.json | sort -V | tail -1)"
cat "$file"
STUB
cat >"$work/bin/aws" <<'STUB'
#!/usr/bin/env bash
[[ -f "$FIXTURES/aws-fail" ]] && { echo "AccessDenied" >&2; exit 255; }
[[ "$*" == *"imageTag=mq-$EXPECT_SHA"* ]] || { echo "unexpected aws call: $*" >&2; exit 3; }
cat "$FIXTURES/ecr.json"
STUB
chmod +x "$work/bin/gh" "$work/bin/aws"

run_json() {
  local status="$1" conclusion="$2" repo="${3:-OxyHQ/Mention}" path="${4:-.github/workflows/merge-queue-image.yml}" event="${5:-merge_group}" head="${6:-$sha}"
  printf '{"status":"%s","conclusion":%s,"event":"%s","head_sha":"%s","path":"%s","head_repository":{"full_name":"%s"}}' \
    "$status" "$([[ "$conclusion" == null ]] && echo null || echo "\"$conclusion\"")" "$event" "$head" "$path" "$repo"
}
ecr_found="{\"images\":[{\"imageId\":{\"imageDigest\":\"$digest\",\"imageTag\":\"mq-$sha\"}}],\"failures\":[]}"
ecr_missing="{\"images\":[],\"failures\":[{\"imageId\":{\"imageTag\":\"mq-$sha\"},\"failureCode\":\"ImageNotFound\"}]}"

case_() {
  # case_ <name> <expected digest or ""> <ecr json> <runs json>...
  local name="$1" expected="$2" ecr="$3"
  shift 3
  local dir="$work/$name" i=1
  mkdir -p "$dir"
  printf '%s' "$ecr" >"$dir/ecr.json"
  for runs in "$@"; do
    printf '{"workflow_runs":[%s]}' "$runs" >"$dir/runs.$i.json"
    i=$((i + 1))
  done
  local out
  if ! out="$(PATH="$work/bin:$PATH" FIXTURES="$dir" EXPECT_SHA="$sha" REPOSITORY=oxy/mention SHA="$sha" \
    GITHUB_REPOSITORY=OxyHQ/Mention GITHUB_OUTPUT="$dir/out" POLL_SECS=0 WAIT_SECS="${WAIT:-5}" \
    bash "$script" 2>"$dir/stderr")"; then
    echo "FAIL $name: exited non-zero: $(cat "$dir/stderr")"
    failures=$((failures + 1))
    return
  fi
  if [[ "$out" != "digest=$expected" ]] || ! grep -qx "digest=$expected" "$dir/out"; then
    echo "FAIL $name: expected digest=$expected, got $out ($(tail -1 "$dir/stderr"))"
    failures=$((failures + 1))
  else
    echo "ok   $name"
  fi
}

case_ reuses-a-green-queue-image "$digest" "$ecr_found" "$(run_json completed success)"
case_ waits-for-a-running-queue-job "$digest" "$ecr_found" \
  "$(run_json queued null)" "$(run_json in_progress null)" "$(run_json completed success)"
case_ green-after-an-earlier-failed-attempt "$digest" "$ecr_found" \
  "$(run_json completed failure),$(run_json completed success)"

case_ no-queue-run "" "$ecr_found" ""
case_ failed-queue-run "" "$ecr_found" "$(run_json completed failure)"
case_ cancelled-queue-run "" "$ecr_found" "$(run_json completed cancelled)"
case_ green-run-built-nothing "" "$ecr_missing" "$(run_json completed success)"
case_ other-repository "" "$ecr_found" "$(run_json completed success someone/oxy)"
case_ other-workflow "" "$ecr_found" "$(run_json completed success OxyHQ/Mention .github/workflows/evil.yml)"
case_ not-merge-group "" "$ecr_found" "$(run_json completed success OxyHQ/Mention .github/workflows/merge-queue-image.yml push)"
case_ other-sha "" "$ecr_found" \
  "$(run_json completed success OxyHQ/Mention .github/workflows/merge-queue-image.yml merge_group fedcba9876543210fedcba9876543210fedcba98)"
WAIT=0 case_ wait-runs-out "" "$ecr_found" "$(run_json in_progress null)"

mkdir -p "$work/github-down" && touch "$work/github-down/gh-fail"
case_ github-down "" "$ecr_found" "$(run_json completed success)"
mkdir -p "$work/ecr-down" && touch "$work/ecr-down/aws-fail"
case_ ecr-down "" "$ecr_found" "$(run_json completed success)"

if ((failures > 0)); then
  echo "$failures resolve-queue-image case(s) failed"
  exit 1
fi
echo "resolve-queue-image: all cases pass"
