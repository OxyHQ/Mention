#!/usr/bin/env bash

set -Eeuo pipefail

# Post-deploy smoke checks for the Mention backend.
#
# Every check declares a FAILURE CLASS, because the two classes earn different
# remedies from `.github/scripts/deploy-ecs-image.sh`:
#
#   hermetic  — the image just deployed is the only thing in the response path
#               that this pipeline changed, so a failure means "put the previous
#               image back". Both hermetic checks are served from
#               `api.mention.earth`, which is a DNS-only record straight to the
#               ALB: no Cloudflare, and no other service's availability decides
#               the answer.
#
#   dependent — the check crosses a boundary this deploy does not own: the three
#               apex checks go through Cloudflare (`mention.earth` is a proxied
#               record), and the federation routes behind them consult oxy-api
#               for fediverse-sharing consent. A failure here can indict
#               something a rollback cannot repair, so it PAGES — the job goes
#               red — while the image just deployed stays live.
#
# The class is a required argument of `request`, not a default, so a check
# cannot land uncategorised: naming no class, or a class that is not one of the
# two, stops the script.
#
# Exit protocol, consumed by `deploy-ecs-image.sh`:
#
#   0   every check passed (possibly with advisories)
#   1   at least one HERMETIC check failed         → roll back
#   75  only DEPENDENT checks failed (EX_TEMPFAIL) → page, do not roll back
#
# Every check runs even after an earlier one fails. Stopping at the first
# failure would let a dependent failure hide a hermetic one behind it and
# suppress the rollback that hermetic failure exists to trigger.

API_ORIGIN="${API_ORIGIN:-https://api.mention.earth}"
WEB_ORIGIN="${WEB_ORIGIN:-https://mention.earth}"
smoke_dir="$(mktemp -d)"
temporary_root="$(realpath "${TMPDIR:-/tmp}")"
smoke_dir="$(realpath "$smoke_dir")"

readonly ROLLBACK_EXIT=1
readonly NO_ROLLBACK_EXIT=75

declare -A check_class=()
declare -A check_failed=()
declare -A permitted_status=()
declare -A permitted_reason=()
hermetic_failures=0
dependent_failures=0

cleanup_smoke_dir() {
  if [[ "$smoke_dir" == "$temporary_root/"* && -d "$smoke_dir" ]]; then
    rm -rf -- "$smoke_dir"
  else
    echo "::warning::Refusing to remove unexpected smoke directory: $smoke_dir"
  fi
}
trap cleanup_smoke_dir EXIT

# An unexpected abort in this script — a missing tool, a typo, a bad path — says
# nothing about the image that was just deployed, so it must never revert one.
# Explicit `exit` statements do not reach this trap, so the two classified exit
# codes above still mean exactly what they say.
trap 'echo "::error::Smoke script aborted unexpectedly at line $LINENO; refusing to attribute that to the deployed image."; exit "$NO_ROLLBACK_EXIT"' ERR

# `request <hermetic|dependent> <name> [curl args...] <url>` — records the
# check's failure class under its name and publishes the HTTP status in
# `http_status` for the expectations that follow. It sets a global rather than
# echoing the status because a `$(...)` capture would run the whole function in
# a subshell, where the class it just recorded would be discarded.
#
# A transport failure (DNS, TCP, TLS, timeout) publishes curl's own `000`, which
# no expectation matches, so it fails that check under that check's class
# instead of aborting the run under none.
http_status=""
request() {
  local class="$1"
  local name="$2"
  shift 2

  case "$class" in
    hermetic | dependent) ;;
    *)
      echo "::error::Check $name declared an unknown failure class '$class' (expected hermetic or dependent)."
      exit "$NO_ROLLBACK_EXIT"
      ;;
  esac
  check_class["$name"]="$class"

  local curl_exit=0
  http_status="$(curl \
    --silent \
    --show-error \
    --max-time 20 \
    --retry 4 \
    --retry-delay 2 \
    --retry-all-errors \
    --max-redirs 0 \
    --dump-header "$smoke_dir/$name.headers" \
    --output "$smoke_dir/$name.body" \
    --write-out '%{http_code}' \
    "$@")" || curl_exit=$?
  if (( curl_exit != 0 )); then
    echo "::notice::$name: curl exited $curl_exit before completing the transfer."
  fi
}

# Record the failure against the class its check declared, once per check, so a
# check that fails two expectations is not counted twice.
fail_check() {
  local name="$1"
  local message="$2"
  local class="${check_class[$name]:-}"

  if [[ -z "$class" ]]; then
    echo "::error::Check $name reported a result without declaring a failure class."
    exit "$NO_ROLLBACK_EXIT"
  fi
  if [[ -n "${check_failed[$name]:-}" ]]; then
    return 0
  fi
  check_failed["$name"]=1

  if [[ "$class" == "hermetic" ]]; then
    hermetic_failures=$((hermetic_failures + 1))
    echo "::error::$message. This check is hermetic — only the deployed image can cause it, so the deployment will be rolled back."
  else
    dependent_failures=$((dependent_failures + 1))
    echo "::error::$message. This check is dependent — it crosses Cloudflare and/or oxy-api, which a rollback cannot repair, so the deployed image stays live and this needs a human."
  fi
}

# Register a status a check may legitimately answer INSTEAD of the expected one,
# with the reason it is legitimate. The answer is still constrained to that set
# and still has to satisfy every other expectation; the alternative is reported
# as a warning, never silently accepted.
permit_alternative() {
  permitted_status["$1"]="$2"
  permitted_reason["$1"]="$3"
}

expect_status() {
  local name="$1"
  local actual="$2"
  local expected="$3"

  if [[ "$actual" == "$expected" ]]; then
    return 0
  fi
  if [[ -n "${permitted_status[$name]:-}" && "$actual" == "${permitted_status[$name]}" ]]; then
    echo "::warning::$name returned HTTP $actual instead of $expected. ${permitted_reason[$name]}"
    return 0
  fi
  fail_check "$name" "$name returned HTTP $actual (expected $expected)"
}

# `expect_nonempty_collection <name> <jq-path> <what>` — the VACUITY FLOOR.
#
# A 200 says the process answered. It does not say the process has a database
# behind it: an empty store answers the anonymous feed with `{"data":{"items":
# []}}` and HTTP 200, so `expect_status` alone cannot tell a healthy deployment
# from one pointed at nothing. That is not hypothetical — a trunk image went
# live against an empty Postgres on 2026-08-04, these checks passed, and the
# rollback came from an unrelated post-deploy task crashing.
#
# It needs no "the store is legitimately empty right now" escape hatch, and that
# is a property of the deploy order rather than luck: the pre-rollout one-shots
# run before any task takes traffic, and a window that deliberately empties or
# reloads the store holds the service at desired count 0 while it does — so the
# only moment the store is legitimately empty is a moment this script does not
# run. If that ORDER ever changes, this check is what will notice.
#
# Prints what it counted and what it required on SUCCESS too. A check that says
# only "passed" leaves nobody able to tell later whether it looked at anything —
# which is how a capped or empty result becomes a fact about the system rather
# than a fact about the measurement.
expect_nonempty_collection() {
  local name="$1"
  local path="$2"
  local what="$3"

  if [[ -n "${check_failed[$name]:-}" ]]; then
    return 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    # A missing tool says nothing about the deployed image, so it must not
    # revert one — the same rule the ERR trap follows.
    echo "::error::jq is not installed, so $name's population floor could not be evaluated. Refusing to attribute that to the deployed image."
    exit "$NO_ROLLBACK_EXIT"
  fi

  # TYPE first, then length, and the order is the check. `jq` answers
  # `null | length` with 0, so counting straight away reports a response whose
  # SHAPE changed — a missing key, a renamed field, an error object — as "the
  # store is empty". Both end in a rollback, but they send whoever reads the log
  # to different places, and a floor that cannot tell them apart is a floor that
  # states a fact about the data on the strength of a fact about the parser.
  local kind count
  kind="$(jq -r "$path | type" "$smoke_dir/$name.body" 2>/dev/null || true)"
  if [[ "$kind" != "array" ]]; then
    fail_check "$name" \
      "$name returned a body with no \`$path\` array at all (found: ${kind:-unparseable}), so $what could not be counted. This is a response SHAPE change, not an empty store"
    return 0
  fi
  count="$(jq -r "$path | length" "$smoke_dir/$name.body")"
  if (( count < 1 )); then
    fail_check "$name" \
      "$name returned 0 $what (\`$path\` is empty). The process answered, so this is not a dead task — it is a LIVE task whose store has nothing in it. Check that the image is pointed at the populated database"
    return 0
  fi
  echo "::notice::$name: $count $what (floor 1, from \`$path\`)."
}

expect_json_response() {
  local name="$1"

  # A check that already failed its status has nothing useful to say about its
  # content type, and on a transport failure there are no headers to read.
  if [[ -n "${check_failed[$name]:-}" ]]; then
    return 0
  fi
  if ! grep -Eiq '^content-type: *application/(activity\+json|ld\+json|json)' \
    "$smoke_dir/$name.headers"; then
    fail_check "$name" "$name did not return a JSON/ActivityPub content type"
  fi
}

# --- hermetic: api.mention.earth, DNS-only to the ALB ------------------------

# Readiness is the deployed process describing itself. The rollout already
# reached a healthy steady state to get here, so a 503 now is the new image
# degrading after the fact.
request hermetic readiness "$API_ORIGIN/health/ready"
expect_status readiness "$http_status" 200

# The anonymous feed is the widest read path in the app. It is hermetic despite
# touching Oxy: author hydration soft-fails to a degraded summary rather than
# throwing, so an oxy-api outage costs display names here, not a 5xx.
#
# `limit=8` rather than 1: the floor asks whether the store has content, and a
# single-item page can be emptied by one ranking decision about one post, which
# would make this fire on a healthy deployment. A for-you page that yields
# nothing at all across eight is a store answer, not a ranking answer.
request hermetic anonymous-feed "$API_ORIGIN/feed/mtn?descriptor=for_you&limit=8"
expect_status anonymous-feed "$http_status" 200
expect_nonempty_collection anonymous-feed '.data.items' 'feed item(s)'

# --- dependent: mention.earth, a Cloudflare-proxied record -------------------

request dependent webfinger "$WEB_ORIGIN/.well-known/webfinger?resource=acct:__smoke_missing__@mention.earth"
expect_status webfinger "$http_status" 404
expect_json_response webfinger

request dependent actor \
  --header 'Accept: application/activity+json' \
  "$WEB_ORIGIN/ap/users/__smoke_missing__"
expect_status actor "$http_status" 404
expect_json_response actor

# The inbox POST is the one check no GET can stand in for. The apex ActivityPub
# ENDPOINT paths have to be served directly — never 301/302'd, never swallowed
# by the SPA proxy — because a redirect there kills ALL inbound federation while
# every GET keeps working, so the profile still renders and looks healthy. What
# this check is really asserting is that the AP router itself answered: a 404
# and a 401 both prove that, while a redirect, an HTML body from the SPA
# fallback, or a 5xx do not.
#
# 401 is therefore a permitted answer rather than a failure. The route 404s for
# a consent state of 'disabled' or 'unknown-user'; when the oxy-api lookup
# behind that read fails it returns 'unavailable', which deliberately does NOT
# 404 — a 4xx makes Mastodon drop deliveries permanently — so the request falls
# through to signature verification and this unsigned body earns its 401. On
# 2026-08-02 oxy-api was scaled to zero tasks for ~12 minutes, the inbox
# answered 401, and this check reverted a perfectly good deploy.
permit_alternative inbox 401 \
  "401 means the fediverse-sharing consent read returned 'unavailable' — the oxy-api lookup behind it failed — which the inbox route is specified to pass through rather than 404. The AP router still answered, so the endpoint is mounted and reachable; check oxy-api's health."
request dependent inbox \
  --request POST \
  --header 'Accept: application/activity+json' \
  --header 'Content-Type: application/activity+json' \
  --data '{}' \
  "$WEB_ORIGIN/ap/users/__smoke_missing__/inbox"
expect_status inbox "$http_status" 404
expect_json_response inbox

# --- verdict -----------------------------------------------------------------

if (( hermetic_failures > 0 )); then
  echo "::error::Mention post-deploy smoke checks failed $hermetic_failures hermetic check(s); rolling the deployment back."
  exit "$ROLLBACK_EXIT"
fi
if (( dependent_failures > 0 )); then
  echo "::error::Mention post-deploy smoke checks failed $dependent_failures dependent check(s) and no hermetic ones. The deployed image is live and will NOT be rolled back — investigate Cloudflare and oxy-api."
  exit "$NO_ROLLBACK_EXIT"
fi

echo "Mention post-deploy smoke checks passed."
