#!/usr/bin/env bash

# Adds the OPTIONAL task-definition bindings to the fixed ones the deploy step
# declares, and prints the merged set as one JSON object on stdout:
#
#   {"secrets": {...}, "environment": {...}, "environmentRemovals": [...]}
#
# for the deploy step to hand to deploy-ecs-image.sh as
# TASK_SECRET_OVERRIDES_JSON, TASK_ENV_OVERRIDES_JSON and TASK_ENV_REMOVALS.
#
# OPTIONAL SECRETS (OPTIONAL_TASK_SECRETS) are bound only when the sync step
# wrote their parameter IN THIS RUN (SYNCED_SECRETS, names only). That is the
# whole start-safety argument: a task definition naming a parameter that does
# not exist registers fine and then cannot start, and a merge that lands before
# anybody sets the GitHub secret must not produce one. The sync step runs first
# and fails the job if a write fails, so a name it reports exists in SSM by the
# time the revision naming it is registered. A name it did not report gets no
# NEW binding — though a binding already on the running revision rides forward
# as every secret does, and its parameter is still there, because the sync only
# ever overwrites.
#
# OPTIONAL ENVIRONMENT (OPTIONAL_TASK_ENV) comes from repository variables, read
# from OPTIONAL_ENV_<NAME>. Set: validated against what the backend's config
# schema accepts and rendered. Unset: REMOVED from the revision, so the code
# default applies and clearing a variable actually withdraws it (the render
# derives from the running revision; not naming a variable removes nothing).
# deploy-ecs-image.sh refuses empty environment values, so "unset" can never be
# rendered as "".
#
# Secret VALUES never reach this script.

set -euo pipefail

: "${APP:?APP is required}"
: "${AWS_REGION:?AWS_REGION is required}"
: "${AWS_ACCOUNT_ID:?AWS_ACCOUNT_ID is required}"

TASK_SECRET_OVERRIDES_JSON="${TASK_SECRET_OVERRIDES_JSON:-}"
TASK_ENV_OVERRIDES_JSON="${TASK_ENV_OVERRIDES_JSON:-}"
TASK_ENV_REMOVALS="${TASK_ENV_REMOVALS:-}"
OPTIONAL_TASK_SECRETS="${OPTIONAL_TASK_SECRETS:-}"
OPTIONAL_TASK_ENV="${OPTIONAL_TASK_ENV:-}"
SYNCED_SECRETS="${SYNCED_SECRETS:-}"

[[ -n "$TASK_SECRET_OVERRIDES_JSON" ]] || TASK_SECRET_OVERRIDES_JSON='{}'
[[ -n "$TASK_ENV_OVERRIDES_JSON" ]] || TASK_ENV_OVERRIDES_JSON='{}'

if [[ ! "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ || ! "$AWS_REGION" =~ ^[a-z0-9-]+$ || ! "$APP" =~ ^[a-z0-9-]+$ ]]; then
  echo "::error::APP, AWS_REGION or AWS_ACCOUNT_ID is malformed." >&2
  exit 1
fi
for json in "$TASK_SECRET_OVERRIDES_JSON" "$TASK_ENV_OVERRIDES_JSON"; do
  if ! jq -e 'type == "object"' <<<"$json" >/dev/null 2>&1; then
    echo "::error::TASK_SECRET_OVERRIDES_JSON and TASK_ENV_OVERRIDES_JSON must be JSON objects." >&2
    exit 1
  fi
done

valid_name() {
  [[ "$1" =~ ^[A-Z][A-Z0-9_]{0,127}$ ]]
}

contains_word() {
  local needle="$1" word
  shift
  for word in $*; do
    [[ "$word" == "$needle" ]] && return 0
  done
  return 1
}

# What the backend's config schema (packages/backend/src/config/index.ts)
# accepts for each optional variable. A value it rejects crash-loops boot and
# the circuit breaker reverts the release; refusing here fails before any
# revision is registered. A name with no rule is refused rather than passed
# through unchecked.
validate_env_value() {
  local name="$1" value="$2"
  case "$name" in
    INSTAGRAM_GRAPH_ENABLED | FEDERATED_MEDIA_DELETE_ENABLED)
      [[ "$value" == "true" || "$value" == "false" ]]
      ;;
    META_GRAPH_API_VERSION)
      [[ "$value" =~ ^v[0-9]{1,3}\.[0-9]{1,3}$ ]]
      ;;
    INSTAGRAM_GRAPH_FOLLOW_BACKFILL_LIMIT)
      [[ "$value" =~ ^[1-9][0-9]{0,2}$ ]] && (( value <= 200 ))
      ;;
    *)
      echo "::error::$name has no validation rule in optional-task-bindings.sh; add one before making it optional." >&2
      return 2
      ;;
  esac
}

secrets="$TASK_SECRET_OVERRIDES_JSON"
for name in $OPTIONAL_TASK_SECRETS; do
  if ! valid_name "$name"; then
    echo "::error::OPTIONAL_TASK_SECRETS must be environment variable names; got '$name'." >&2
    exit 1
  fi
  if jq -e --arg name "$name" 'has($name)' <<<"$secrets" >/dev/null; then
    echo "::error::$name is both a fixed and an optional task secret. Remove it from one." >&2
    exit 1
  fi
  if contains_word "$name" "$SYNCED_SECRETS"; then
    arn="arn:aws:ssm:${AWS_REGION}:${AWS_ACCOUNT_ID}:parameter/oxy/${APP}/${name}"
    secrets="$(jq -c --arg name "$name" --arg arn "$arn" '. + {($name): $arn}' <<<"$secrets")"
    echo "Binding $name: its parameter was synced in this run." >&2
  else
    echo "::notice::Not binding $name: secrets.$name was not synced in this run (unset or placeholder)." >&2
  fi
done

environment="$TASK_ENV_OVERRIDES_JSON"
removals="$TASK_ENV_REMOVALS"
for name in $OPTIONAL_TASK_ENV; do
  if ! valid_name "$name"; then
    echo "::error::OPTIONAL_TASK_ENV must be environment variable names; got '$name'." >&2
    exit 1
  fi
  if jq -e --arg name "$name" 'has($name)' <<<"$environment" >/dev/null ||
     contains_word "$name" "$removals"; then
    echo "::error::$name is both a fixed and an optional task environment variable. Remove it from one." >&2
    exit 1
  fi
  value_variable="OPTIONAL_ENV_${name}"
  value="${!value_variable:-}"
  if [[ -z "$value" ]]; then
    removals="${removals:+$removals }$name"
    echo "$name: repository variable unset; removed from the revision so the code default applies." >&2
    continue
  fi
  status=0
  validate_env_value "$name" "$value" || status=$?
  if (( status == 2 )); then
    exit 1
  elif (( status != 0 )); then
    echo "::error::vars.$name='$value' is not a value the backend accepts; refusing before any task definition is registered." >&2
    exit 1
  fi
  environment="$(jq -c --arg name "$name" --arg value "$value" '. + {($name): $value}' <<<"$environment")"
  echo "$name=$value" >&2
done

jq -cn \
  --argjson secrets "$secrets" \
  --argjson environment "$environment" \
  --arg removals "$removals" \
  '{
    secrets: $secrets,
    environment: $environment,
    environmentRemovals: ($removals | split(" ") | map(select(length > 0)))
  }'
