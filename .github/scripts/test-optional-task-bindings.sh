#!/usr/bin/env bash

# Offline cases for optional-task-bindings.sh. The one that matters most is the
# first: a merge that lands before anybody sets the GitHub secrets must render
# NO binding for them, because a binding to a missing parameter registers fine
# and then cannot start.

set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/optional-task-bindings.sh"
failures=0

run() {
  env -i PATH="$PATH" \
    APP=mention AWS_REGION=us-west-2 AWS_ACCOUNT_ID=237343248947 \
    TASK_SECRET_OVERRIDES_JSON='{"DATABASE_URL":"arn:aws:ssm:us-west-2:237343248947:parameter/oxy/mention/DATABASE_URL"}' \
    TASK_ENV_OVERRIDES_JSON='{"WEB_SHELL_ORIGIN":"https://shell.mention.earth"}' \
    TASK_ENV_REMOVALS='ATPROTO_ENABLED' \
    OPTIONAL_TASK_SECRETS='META_GRAPH_ACCESS_TOKEN META_IG_BUSINESS_ACCOUNT_ID' \
    OPTIONAL_TASK_ENV='INSTAGRAM_GRAPH_ENABLED META_GRAPH_API_VERSION INSTAGRAM_GRAPH_FOLLOW_BACKFILL_LIMIT FEDERATED_MEDIA_DELETE_ENABLED' \
    "$@" bash "$script" 2>/dev/null
}

expect() {
  local case_name="$1" filter="$2"
  shift 2
  local output
  if ! output="$(run "$@")"; then
    echo "FAIL $case_name: script exited non-zero" >&2
    failures=$((failures + 1))
    return
  fi
  if ! jq -e "$filter" <<<"$output" >/dev/null; then
    echo "FAIL $case_name: $output" >&2
    failures=$((failures + 1))
  fi
}

expect_refusal() {
  local case_name="$1"
  shift
  if run "$@" >/dev/null; then
    echo "FAIL $case_name: expected a refusal" >&2
    failures=$((failures + 1))
  fi
}

# Nothing set: fixed bindings pass through untouched, no optional secret is
# bound, and every optional variable is removed so the code default applies.
expect 'nothing-set' '
  .secrets == {"DATABASE_URL":"arn:aws:ssm:us-west-2:237343248947:parameter/oxy/mention/DATABASE_URL"}
  and .environment == {"WEB_SHELL_ORIGIN":"https://shell.mention.earth"}
  and .environmentRemovals == ["ATPROTO_ENABLED","INSTAGRAM_GRAPH_ENABLED","META_GRAPH_API_VERSION","INSTAGRAM_GRAPH_FOLLOW_BACKFILL_LIMIT","FEDERATED_MEDIA_DELETE_ENABLED"]'

# Only a secret synced THIS run is bound, at its exact /oxy/<app>/ path.
expect 'one-synced' '
  .secrets.META_GRAPH_ACCESS_TOKEN == "arn:aws:ssm:us-west-2:237343248947:parameter/oxy/mention/META_GRAPH_ACCESS_TOKEN"
  and (.secrets | has("META_IG_BUSINESS_ACCOUNT_ID") | not)
  and (.secrets | has("DATABASE_URL"))' \
  SYNCED_SECRETS='DATABASE_URL META_GRAPH_ACCESS_TOKEN'

expect 'both-synced' '
  (.secrets | keys) == ["DATABASE_URL","META_GRAPH_ACCESS_TOKEN","META_IG_BUSINESS_ACCOUNT_ID"]' \
  SYNCED_SECRETS='META_IG_BUSINESS_ACCOUNT_ID META_GRAPH_ACCESS_TOKEN'

# A name must match whole: a synced META_GRAPH_ACCESS_TOKEN_OLD binds nothing.
expect 'no-prefix-match' '(.secrets | has("META_GRAPH_ACCESS_TOKEN") | not)' \
  SYNCED_SECRETS='META_GRAPH_ACCESS_TOKEN_OLD'

# Set variables render; unset ones are removed.
expect 'flags-set' '
  .environment.INSTAGRAM_GRAPH_ENABLED == "true"
  and .environment.META_GRAPH_API_VERSION == "v23.0"
  and .environment.INSTAGRAM_GRAPH_FOLLOW_BACKFILL_LIMIT == "200"
  and .environment.FEDERATED_MEDIA_DELETE_ENABLED == "false"
  and .environmentRemovals == ["ATPROTO_ENABLED"]' \
  OPTIONAL_ENV_INSTAGRAM_GRAPH_ENABLED=true \
  OPTIONAL_ENV_META_GRAPH_API_VERSION=v23.0 \
  OPTIONAL_ENV_INSTAGRAM_GRAPH_FOLLOW_BACKFILL_LIMIT=200 \
  OPTIONAL_ENV_FEDERATED_MEDIA_DELETE_ENABLED=false

# Values the backend's config schema would reject at boot are refused here.
expect_refusal 'bad-boolean' OPTIONAL_ENV_INSTAGRAM_GRAPH_ENABLED=TRUE
expect_refusal 'bad-boolean-yes' OPTIONAL_ENV_FEDERATED_MEDIA_DELETE_ENABLED=yes
expect_refusal 'bad-version' OPTIONAL_ENV_META_GRAPH_API_VERSION=23.0
expect_refusal 'limit-zero' OPTIONAL_ENV_INSTAGRAM_GRAPH_FOLLOW_BACKFILL_LIMIT=0
expect_refusal 'limit-too-high' OPTIONAL_ENV_INSTAGRAM_GRAPH_FOLLOW_BACKFILL_LIMIT=201
expect_refusal 'limit-not-integer' OPTIONAL_ENV_INSTAGRAM_GRAPH_FOLLOW_BACKFILL_LIMIT=5.5

# An optional name with no validation rule is refused, not passed through.
expect_refusal 'unknown-optional-env' OPTIONAL_TASK_ENV='SOMETHING_NEW' OPTIONAL_ENV_SOMETHING_NEW=x

# A name that is both fixed and optional is ambiguous; refuse rather than pick.
expect_refusal 'secret-both-fixed-and-optional' OPTIONAL_TASK_SECRETS='DATABASE_URL'
expect_refusal 'env-both-fixed-and-optional' OPTIONAL_TASK_ENV='WEB_SHELL_ORIGIN'
expect_refusal 'env-both-removed-and-optional' OPTIONAL_TASK_ENV='ATPROTO_ENABLED'

if (( failures > 0 )); then
  echo "$failures optional-task-bindings case(s) failed." >&2
  exit 1
fi
echo "optional-task-bindings: all cases passed."
