#!/usr/bin/env bash

set -euo pipefail

# Drives .github/scripts/smoke-mention.sh against a stubbed `curl` so the
# classification it encodes is testable without a deployment.
#
# What is stubbed: `curl` only. Every scenario names, per check, the HTTP status
# the origin answers, the content type it answers with, and whether curl reaches
# the origin at all. The script under test is otherwise unmodified — it computes
# its own verdict and its own exit code, which is the thing being asserted,
# because that exit code is the entire interface `deploy-ecs-image.sh` uses to
# decide whether to roll a deployment back.

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
smoke_script="$repository_root/.github/scripts/smoke-mention.sh"
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

# Every check this script knows about, in the order smoke-mention.sh runs them.
# The order is asserted on every scenario, which is what proves a failing check
# does not stop the ones after it.
readonly EXPECTED_CHECK_ORDER='readiness
anonymous-feed
webfinger
actor
inbox'

# Stubbed curl. Derives which check is calling from the `--dump-header` path
# smoke-mention.sh passes, then answers from the scenario's environment.
curl() {
  local dump_header="" output="" previous="" argument name key status content_type curl_exit
  for argument in "$@"; do
    case "$previous" in
      --dump-header) dump_header="$argument" ;;
      --output) output="$argument" ;;
    esac
    previous="$argument"
  done

  if [[ -z "$dump_header" ]]; then
    echo "Stubbed curl received no --dump-header; cannot identify the check." >&2
    return 2
  fi
  name="$(basename "$dump_header" .headers)"
  key="${name//-/_}"

  printf '%s\n' "$name" >>"$SMOKE_TEST_CALL_LOG"

  local status_variable="SMOKE_TEST_STATUS_${key}"
  local content_type_variable="SMOKE_TEST_CT_${key}"
  local curl_exit_variable="SMOKE_TEST_CURL_EXIT_${key}"
  status="${!status_variable:-}"
  content_type="${!content_type_variable:-application/json; charset=utf-8}"
  curl_exit="${!curl_exit_variable:-0}"

  if [[ -z "$status" ]]; then
    echo "Stubbed curl has no configured status for check $name." >&2
    return 2
  fi

  if (( curl_exit != 0 )); then
    # curl writes an empty header dump and reports 000 when it never completes
    # a transfer — reproduce both, since the script reads both.
    : >"$dump_header"
    [[ -n "$output" ]] && : >"$output"
    printf '000\n'
    return "$curl_exit"
  fi

  printf 'HTTP/2 %s\r\ncontent-type: %s\r\n\r\n' "$status" "$content_type" >"$dump_header"
  [[ -n "$output" ]] && printf '{}' >"$output"
  printf '%s\n' "$status"
}
export -f curl

# run_scenario <name> <expected exit code> [VAR=value ...]
run_scenario() {
  local scenario="$1"
  local expected_exit="$2"
  shift 2

  local scenario_directory="$test_directory/$scenario"
  mkdir -p "$scenario_directory"

  local -a scenario_environment=(
    "SMOKE_TEST_CALL_LOG=$scenario_directory/calls.log"
    SMOKE_TEST_STATUS_readiness=200
    SMOKE_TEST_STATUS_anonymous_feed=200
    SMOKE_TEST_STATUS_webfinger=404
    SMOKE_TEST_STATUS_actor=404
    SMOKE_TEST_STATUS_inbox=404
    "$@"
  )

  : >"$scenario_directory/calls.log"
  local actual_exit=0
  env "${scenario_environment[@]}" bash "$smoke_script" \
    >"$scenario_directory/output.log" 2>&1 || actual_exit=$?

  if [[ "$actual_exit" != "$expected_exit" ]]; then
    echo "Scenario $scenario exited $actual_exit (expected $expected_exit)." >&2
    sed -n '1,80p' "$scenario_directory/output.log" >&2
    return 1
  fi

  # Vacuity floor: a scenario that silently skipped checks would otherwise pass
  # by never exercising the assertion it was written for.
  if [[ "$(<"$scenario_directory/calls.log")" != "$EXPECTED_CHECK_ORDER" ]]; then
    echo "Scenario $scenario did not run every check in order:" >&2
    cat "$scenario_directory/calls.log" >&2
    return 1
  fi
}

expect_output() {
  local scenario="$1"
  local needle="$2"
  if ! grep -qF "$needle" "$test_directory/$scenario/output.log"; then
    echo "Scenario $scenario output is missing: $needle" >&2
    sed -n '1,80p' "$test_directory/$scenario/output.log" >&2
    exit 1
  fi
}

refute_output() {
  local scenario="$1"
  local needle="$2"
  if grep -qF "$needle" "$test_directory/$scenario/output.log"; then
    echo "Scenario $scenario output should not contain: $needle" >&2
    sed -n '1,80p' "$test_directory/$scenario/output.log" >&2
    exit 1
  fi
}

# A healthy production answers exactly this, and the script must stay silent.
run_scenario healthy 0
expect_output healthy "Mention post-deploy smoke checks passed."
refute_output healthy "::error::"
refute_output healthy "::warning::"

# The 2026-08-02 regression: oxy-api was unreachable, the consent read returned
# 'unavailable', the inbox fell through to signature verification and answered
# 401 — a documented, permitted answer. It must not fail the run at all.
run_scenario inbox-401-during-oxy-outage 0 SMOKE_TEST_STATUS_inbox=401
expect_output inbox-401-during-oxy-outage "::warning::inbox returned HTTP 401 instead of 404"
expect_output inbox-401-during-oxy-outage "Mention post-deploy smoke checks passed."
refute_output inbox-401-during-oxy-outage "::error::"

# The permitted 401 is a permitted STATUS, not a blanket pass: an HTML body at
# that status means something other than the AP router answered.
run_scenario inbox-401-but-html 75 \
  SMOKE_TEST_STATUS_inbox=401 \
  "SMOKE_TEST_CT_inbox=text/html; charset=utf-8"
expect_output inbox-401-but-html "inbox did not return a JSON/ActivityPub content type"

# Anything outside the permitted set is still a failure — loud, but not a
# rollback, because the apex path it crosses is not this image's to fix.
run_scenario inbox-500 75 SMOKE_TEST_STATUS_inbox=500
expect_output inbox-500 "inbox returned HTTP 500 (expected 404)"
expect_output inbox-500 "This check is dependent"
expect_output inbox-500 "will NOT be rolled back"

# The regression the inbox check exists to catch: an apex AP endpoint path
# answering with a redirect instead of being served directly.
run_scenario actor-redirected 75 SMOKE_TEST_STATUS_actor=302
expect_output actor-redirected "actor returned HTTP 302 (expected 404)"

# The SPA fallback shape — right status, wrong server answering.
run_scenario webfinger-html 75 "SMOKE_TEST_CT_webfinger=text/html; charset=utf-8"
expect_output webfinger-html "webfinger did not return a JSON/ActivityPub content type"

# Hermetic failures still roll back. This is the case a change like this one is
# most likely to break, so it is asserted from both directions below.
run_scenario readiness-503 1 SMOKE_TEST_STATUS_readiness=503
expect_output readiness-503 "readiness returned HTTP 503 (expected 200)"
expect_output readiness-503 "This check is hermetic"
expect_output readiness-503 "rolling the deployment back"

run_scenario feed-500 1 SMOKE_TEST_STATUS_anonymous_feed=500
expect_output feed-500 "anonymous-feed returned HTTP 500 (expected 200)"
expect_output feed-500 "rolling the deployment back"

# A transport failure to the hermetic origin is a rollback, not an advisory:
# curl reports 000, which no expectation matches, and the check's own class
# decides the remedy.
run_scenario feed-unreachable 1 \
  SMOKE_TEST_CURL_EXIT_anonymous_feed=7 \
  SMOKE_TEST_STATUS_anonymous_feed=200
expect_output feed-unreachable "curl exited 7"
expect_output feed-unreachable "anonymous-feed returned HTTP 000 (expected 200)"
expect_output feed-unreachable "rolling the deployment back"

# A dependent failure must never mask a hermetic one. Both fail here; the run
# has to end in a rollback, and the dependent failure has to be reported too.
run_scenario hermetic-outranks-dependent 1 \
  SMOKE_TEST_STATUS_readiness=503 \
  SMOKE_TEST_STATUS_webfinger=500
expect_output hermetic-outranks-dependent "readiness returned HTTP 503 (expected 200)"
expect_output hermetic-outranks-dependent "webfinger returned HTTP 500 (expected 404)"
expect_output hermetic-outranks-dependent "rolling the deployment back"
refute_output hermetic-outranks-dependent "will NOT be rolled back"

echo "Mention smoke check classification tests passed."
