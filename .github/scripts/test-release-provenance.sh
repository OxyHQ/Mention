#!/usr/bin/env bash

# Offline cases for release-provenance.sh, with `gh` replaced by a stub that
# answers from fixtures. The cases that matter are the exclusivity table (each
# commit is released by exactly one path) and the refusals: an API failure must
# be red, never read as "not verified", and a merge_group run that is green but
# whose `CI complete` is not must not vouch for anything.

set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-provenance.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0
sha=0123456789abcdef0123456789abcdef01234567

mkdir -p "$work/bin"
cat >"$work/bin/gh" <<'STUB'
#!/usr/bin/env bash
# Answers `gh api [--paginate] <path>` from $FIXTURES.
path="${@: -1}"
case "$path" in
  *"/actions/workflows/ci.yml/runs?"*) file="$FIXTURES/runs.json" ;;
  *"/actions/runs/"*"/jobs?"*) id="${path#*/actions/runs/}"; file="$FIXTURES/jobs-${id%%/*}.json" ;;
  *) echo "unexpected gh call: $*" >&2; exit 2 ;;
esac
[[ -f "$FIXTURES/fail" ]] && { echo "HTTP 502" >&2; exit 1; }
cat "$file"
STUB
chmod +x "$work/bin/gh"

fixture() {
  # fixture <name> <runs-json> [<run-id> <jobs-json>]...
  local dir="$work/$1"
  mkdir -p "$dir"
  printf '%s' "$2" >"$dir/runs.json"
  shift 2
  while [[ $# -gt 0 ]]; do
    printf '%s' "$2" >"$dir/jobs-$1.json"
    shift 2
  done
}

run_json() {
  local id="$1" event="$2" conclusion="$3" repo="${4:-OxyHQ/Mention}" path="${5:-.github/workflows/ci.yml}" head="${6:-$sha}"
  printf '{"id":%s,"event":"%s","conclusion":"%s","head_sha":"%s","path":"%s","head_repository":{"full_name":"%s"}}' \
    "$id" "$event" "$conclusion" "$head" "$path" "$repo"
}
jobs_json() { printf '{"jobs":[{"name":"Test backend","conclusion":"success"},{"name":"CI complete","conclusion":"%s"}]}' "$1"; }

fixture verified "{\"workflow_runs\":[$(run_json 11 merge_group success)]}" 11 "$(jobs_json success)"
fixture none '{"workflow_runs":[]}'
fixture failed-run "{\"workflow_runs\":[$(run_json 12 merge_group failure)]}" 12 "$(jobs_json success)"
fixture red-gate "{\"workflow_runs\":[$(run_json 13 merge_group success)]}" 13 "$(jobs_json failure)"
fixture other-sha "{\"workflow_runs\":[$(run_json 14 merge_group success OxyHQ/Mention .github/workflows/ci.yml fedcba9876543210fedcba9876543210fedcba98)]}" 14 "$(jobs_json success)"
fixture other-workflow "{\"workflow_runs\":[$(run_json 15 merge_group success OxyHQ/Mention .github/workflows/evil.yml)]}" 15 "$(jobs_json success)"
fixture fork "{\"workflow_runs\":[$(run_json 16 merge_group success someone/Mention)]}" 16 "$(jobs_json success)"
fixture pull-request "{\"workflow_runs\":[$(run_json 17 pull_request success)]}" 17 "$(jobs_json success)"
fixture api-down '{"workflow_runs":[]}'
touch "$work/api-down/fail"
# The run list answers, the jobs call fails: must still be red.
fixture jobs-down "{\"workflow_runs\":[$(run_json 18 merge_group success)]}"

# Prints "<exit> <outputs>".
run() {
  local name="$1"
  shift
  local output_file="$work/output"
  : >"$output_file"
  local status=0
  env -i PATH="$work/bin:$PATH" FIXTURES="$work/$name" GITHUB_OUTPUT="$output_file" \
    GITHUB_REPOSITORY=OxyHQ/Mention DEPLOY_SHA="$sha" "$@" bash "$script" >/dev/null 2>&1 || status=$?
  echo "$status $(tr '\n' ' ' <"$output_file")"
}

expect() {
  local case_name="$1" want="$2" got="$3"
  if [[ "$got" != "$want" ]]; then
    echo "FAIL $case_name: want '$want', got '$got'" >&2
    failures=$((failures + 1))
  fi
}

push=(GITHUB_EVENT_NAME=push)
fallback=(GITHUB_EVENT_NAME=workflow_run WORKFLOW_RUN_CONCLUSION=success)

# The exclusivity table: exactly one path releases each commit.
expect 'verified-push-releases' '0 release=true ' "$(run verified "${push[@]}")"
expect 'verified-fallback-skips' '0 release=false ' "$(run verified "${fallback[@]}")"
expect 'unverified-push-skips' '0 release=false ' "$(run none "${push[@]}")"
expect 'unverified-fallback-releases' '0 release=true ' "$(run none "${fallback[@]}")"

# Nothing but a green merge_group run of ci.yml, for this SHA, in this repo,
# with a green `CI complete`, counts as verified.
for name in failed-run red-gate other-sha other-workflow fork pull-request; do
  expect "$name-does-not-verify" '0 release=false ' "$(run "$name" "${push[@]}")"
done

# API failures are red, never a quiet "not verified".
expect 'api-down-push-fails' '1 ' "$(run api-down "${push[@]}")"
expect 'api-down-fallback-fails' '1 ' "$(run api-down "${fallback[@]}")"
expect 'jobs-down-fails' '1 ' "$(run jobs-down "${push[@]}")"

# Refusals.
expect 'fallback-for-failed-ci' '1 ' "$(run none GITHUB_EVENT_NAME=workflow_run WORKFLOW_RUN_CONCLUSION=failure)"
expect 'unknown-event' '1 ' "$(run verified GITHUB_EVENT_NAME=workflow_dispatch)"
expect 'short-sha' '1 ' "$(run verified "${push[@]}" DEPLOY_SHA="${sha:0:12}")"

if [[ "$failures" -gt 0 ]]; then
  echo "$failures release-provenance case(s) failed" >&2
  exit 1
fi
echo "release-provenance: all cases passed"
