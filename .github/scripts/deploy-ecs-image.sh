#!/usr/bin/env bash

set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${CLUSTER:?CLUSTER is required}"
: "${APP:?APP is required}"
: "${IMAGE_URI:?IMAGE_URI is required}"
if [[ ! "$IMAGE_URI" =~ ^.+@sha256:[0-9a-fA-F]{64}$ ]]; then
  echo "::error::IMAGE_URI must pin an immutable OCI digest (repository@sha256:<64 hex characters>)."
  exit 1
fi

CONTAINER_NAME="${CONTAINER_NAME:-$APP}"
MAX_WAIT_SECS="${MAX_WAIT_SECS:-1200}"
POLL_INTERVAL="${POLL_INTERVAL:-15}"
RUN_MIGRATIONS="${RUN_MIGRATIONS:-false}"
INTERNAL_METRICS_PARAMETER="${INTERNAL_METRICS_PARAMETER:-}"
TASK_SECRET_OVERRIDES_JSON="${TASK_SECRET_OVERRIDES_JSON:-}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-}"
AWS_PARTITION="${AWS_PARTITION:-aws}"
POST_DEPLOY_SMOKE_SCRIPT="${POST_DEPLOY_SMOKE_SCRIPT:-}"
POST_DEPLOY_TASK_COMMAND_JSON="${POST_DEPLOY_TASK_COMMAND_JSON:-}"
# Deploy a service that is deliberately scaled to ZERO — and say which one.
#
# Every ordinary deploy must refuse a zero-count service: it means capacity was
# lost, and rolling a new image onto nothing produces a green deploy and an
# outage. That guard stays.
#
# The exception it exists for is the Mongo->Postgres cutover. Traffic is stopped
# at desiredCount 0 for the whole window ON PURPOSE, because the running image
# is Mongo-backed: bringing it up after the copy has finished would let real
# user writes land in the store being abandoned, and the copy is not
# incremental, so nothing recovers them. Downtime is acceptable there; losing
# writes is not.
#
# It names the SERVICE rather than being a boolean, for the same reason
# `--confirm-truncate` names the database instead of taking `true`: a bare
# `true` left in a workflow file or pasted out of a runbook authorises a
# zero-count deploy of ANYTHING, and the value that would be wrong is exactly
# the value that is easiest to copy.
ALLOW_ZERO_DESIRED_COUNT="${ALLOW_ZERO_DESIRED_COUNT:-}"

# Whether this run may proceed against a zero-count service.
#
# The value is `<service>:<YYYY-MM-DD>` and BOTH halves must hold: the service
# must be this one, and the date must not have passed. Every other shape refuses.
#
# The expiry is what keeps this from being a permanent reduction in protection.
# Without it, a variable set for one window and never removed silently disarms
# the zero-count guard forever, and the failure only shows up the day somebody
# scales to zero for an unrelated reason and a deploy reports green onto no
# capacity. With it, a forgotten variable disarms ITSELF the day after.
#
# It fails toward REFUSING, which is the direction that matters: if the window
# slips past the expiry the deploy refuses loudly, mid-window, and is fixed in
# thirty seconds by updating the variable. It can never fail toward permitting.
zero_desired_count_allowed=false
if [[ -n "$ALLOW_ZERO_DESIRED_COUNT" ]]; then
  if [[ ! "$ALLOW_ZERO_DESIRED_COUNT" =~ ^[A-Za-z0-9_-]+:[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    echo "::error::ALLOW_ZERO_DESIRED_COUNT is set but malformed: expected <service>:<YYYY-MM-DD>, e.g. $APP:$(date -u -d '+2 days' +%F). Refusing to treat an unparseable authorisation as permission."
    exit 1
  fi
  zero_optin_service="${ALLOW_ZERO_DESIRED_COUNT%%:*}"
  zero_optin_expiry="${ALLOW_ZERO_DESIRED_COUNT#*:}"
  # A regex-valid but NONEXISTENT date (2026-13-45) would sort after every real
  # date and therefore never expire — fail-open, the one direction this must not
  # have. Round-tripping it through `date` rejects that.
  if ! zero_optin_parsed="$(date -u -d "$zero_optin_expiry" +%F 2>/dev/null)" ||
     [[ "$zero_optin_parsed" != "$zero_optin_expiry" ]]; then
    echo "::error::ALLOW_ZERO_DESIRED_COUNT carries an invalid date: $zero_optin_expiry. Refusing."
    exit 1
  fi
  zero_optin_today="$(date -u +%F)"
  # ISO dates compare correctly as strings; the expiry day itself is still valid.
  if [[ "$zero_optin_expiry" < "$zero_optin_today" ]]; then
    echo "::error::ALLOW_ZERO_DESIRED_COUNT expired on $zero_optin_expiry (today is $zero_optin_today). If this window is still running, update the variable; do not delete the expiry."
    exit 1
  fi
  if [[ "$zero_optin_service" == "$APP" ]]; then
    zero_desired_count_allowed=true
  fi
fi
# What `RUN_MIGRATIONS=true` runs, in order, each as its own one-shot task on the
# image being rolled out. A non-zero exit from any of them stops the release
# before `update-service`.
#
# ORDER IS LOAD-BEARING, AND POSTGRES IS FIRST.
#
# The two stores fail differently. The Mongo migrations are data migrations
# against a schema that already exists, and skipping them leaves the previous
# release's behaviour in place. The Postgres migrations are the SCHEMA: a task
# that boots against a database they never reached connects, answers the health
# check, is given traffic, and only then fails every query — the damage lands
# after the point of no return rather than before it. So the store that can
# invalidate the whole rollout is settled first, and a failure there costs
# nothing because nothing has been routed yet.
#
# `assertPostgresMigrationsCurrent` in packages/backend/src/db/migrationLedger.ts
# is the other half: it refuses to let a task become ready when this step did not
# run. Neither replaces the other — this one applies the migrations, that one
# survives the case where somebody bypassed this one.
#
# Both migration entries run during the dual-run. Postgres does not replace
# Mongo yet.
#
# THE THIRD ENTRY IS THE POPULATION FLOOR, and it is last because it is the only
# one that reads rows: the schema has to exist before rows can be counted.
#
# It exists because a 200 is not evidence of a database. A trunk image went live
# against an empty Postgres on 2026-08-04, every post-deploy smoke check passed
# — an empty store answers the anonymous feed 200 with no items — and the
# rollback came from an unrelated task crashing. Placed HERE rather than in the
# smoke checks because a failure here has routed nothing; a smoke failure rolls
# back after the image has already served.
#
# ITS LIFETIME IS THE CUTOVER'S. It asserts that Postgres is authoritative,
# which is false before the cutover and false again after a rollback to Mongo —
# the planned contingency. It therefore ships INSIDE the cutover commit, so
# reverting the cutover reverts it. Landing it separately would leave a guard
# that blocks every deploy after a Mongo rollback, for a reason nothing about
# that rollback would lead anyone to look for.
MIGRATION_TASK_COMMANDS_JSON='[
  {
    "label": "Postgres migration",
    "command": ["bun", "packages/backend/dist/src/db/migrate.js", "--target-database=mention"]
  },
  {
    "label": "Mongo migration",
    "command": ["bun", "packages/backend/dist/scripts/migrate.js"]
  },
  {
    "label": "Postgres population floor",
    "command": ["bun", "packages/backend/dist/src/scripts/assertPostgresPopulated.js"]
  }
]'
# Exit code a smoke script uses to say "this failed, and rolling back cannot fix
# it" — a check that crosses a boundary this deploy does not own (a CDN in front
# of the origin, another service the route consults). Reverting the image for one
# of those trades a working deployment for an outage somebody else is already
# fixing, so the release stands and the job goes red instead.
#
# Every OTHER non-zero code still rolls back, so a smoke script that does not opt
# into the protocol keeps the previous all-or-nothing behaviour.
SMOKE_NO_ROLLBACK_EXIT=75
smoke_reported_external_failure=false
DEPLOY_HEAD_GUARD_SCRIPT="${DEPLOY_HEAD_GUARD_SCRIPT:-.github/scripts/require-current-main.sh}"

if ! [[ "$MAX_WAIT_SECS" =~ ^[0-9]+$ ]] || (( MAX_WAIT_SECS < 1 )); then
  echo "::error::MAX_WAIT_SECS must be a positive integer."
  exit 1
fi
if ! [[ "$POLL_INTERVAL" =~ ^[0-9]+$ ]] || (( POLL_INTERVAL < 1 )); then
  echo "::error::POLL_INTERVAL must be a positive integer."
  exit 1
fi
if [[ "$RUN_MIGRATIONS" != "true" && "$RUN_MIGRATIONS" != "false" ]]; then
  echo "::error::RUN_MIGRATIONS must be either 'true' or 'false'."
  exit 1
fi
if [[ -n "$POST_DEPLOY_SMOKE_SCRIPT" && ! -f "$POST_DEPLOY_SMOKE_SCRIPT" ]]; then
  echo "::error::POST_DEPLOY_SMOKE_SCRIPT does not exist: $POST_DEPLOY_SMOKE_SCRIPT"
  exit 1
fi
if [[ -n "${DEPLOY_SHA:-}" && ! -f "$DEPLOY_HEAD_GUARD_SCRIPT" ]]; then
  echo "::error::DEPLOY_HEAD_GUARD_SCRIPT does not exist: $DEPLOY_HEAD_GUARD_SCRIPT"
  exit 1
fi
if [[ -n "$POST_DEPLOY_TASK_COMMAND_JSON" ]] &&
   ! jq -e '
     type == "array" and
     length > 0 and
     all(.[]; type == "string" and length > 0)
   ' <<<"$POST_DEPLOY_TASK_COMMAND_JSON" >/dev/null; then
  echo "::error::POST_DEPLOY_TASK_COMMAND_JSON must be a non-empty JSON string array."
  exit 1
fi
if [[ -z "$TASK_SECRET_OVERRIDES_JSON" ]]; then
  TASK_SECRET_OVERRIDES_JSON='{}'
fi
if ! jq -e '
  type == "object" and
  length <= 20 and
  all(
    to_entries[];
    (.key | type == "string" and test("^[A-Z][A-Z0-9_]{0,127}$")) and
    (
      .value
      | type == "string" and
        test("^arn:aws(-[a-z]+)?:ssm:[a-z0-9-]+:[0-9]{12}:parameter/[A-Za-z0-9_./-]+$")
    )
  )
' <<<"$TASK_SECRET_OVERRIDES_JSON" >/dev/null; then
  echo "::error::TASK_SECRET_OVERRIDES_JSON must map environment variable names to complete SSM parameter ARNs."
  exit 1
fi

service_json="$(aws ecs describe-services --cluster "$CLUSTER" --services "$APP")"
if [[ "$(jq '.failures | length' <<<"$service_json")" != "0" ||
      "$(jq '.services | length' <<<"$service_json")" != "1" ]]; then
  echo "::error::ECS did not return exactly one service named $APP."
  jq '.failures' <<<"$service_json"
  exit 1
fi
service_status="$(jq -r '.services[0].status // "NONE"' <<<"$service_json")"
if [[ "$service_status" != "ACTIVE" ]]; then
  echo "::error::ECS service $APP is not ACTIVE (status: $service_status)."
  exit 1
fi

current_task_definition="$(jq -r '.services[0].taskDefinition // empty' <<<"$service_json")"
if [[ -z "$current_task_definition" ]]; then
  echo "::error::ECS service $APP has no task definition."
  exit 1
fi

service_desired_count="$(jq -r '.services[0].desiredCount // empty' <<<"$service_json")"
if ! [[ "$service_desired_count" =~ ^[0-9]+$ ]]; then
  echo "::error::ECS service $APP reported a non-numeric desiredCount (${service_desired_count:-missing}); refusing to deploy."
  exit 1
fi
if (( service_desired_count < 1 )) && [[ "$zero_desired_count_allowed" != true ]]; then
  echo "::error::ECS service $APP must have a positive desiredCount before deployment (current: ${service_desired_count:-missing}). Scale the service up explicitly before retrying, or set ALLOW_ZERO_DESIRED_COUNT=$APP:<YYYY-MM-DD> if this is a deliberate zero-capacity deploy."
  exit 1
fi
if (( service_desired_count < 1 )); then
  echo "::warning::Deploying $APP at desiredCount=0, authorised by ALLOW_ZERO_DESIRED_COUNT=$ALLOW_ZERO_DESIRED_COUNT (expires $zero_optin_expiry). The rollout will complete with zero running tasks and the service will serve NOTHING until it is scaled up."
fi

task_definition_file="$(mktemp)"
rendered_task_definition_file="$(mktemp)"
active_one_shot_task_arn=""
active_one_shot_task_stopped=true
active_one_shot_label=""

cleanup() {
  if [[ "$active_one_shot_task_stopped" != "true" &&
        -n "$active_one_shot_task_arn" ]]; then
    echo "::warning::Unfinished $active_one_shot_label task $active_one_shot_task_arn may still be running; the deploy role cannot call ecs:StopTask."
  fi
  rm -f "$task_definition_file" "$rendered_task_definition_file"
}
trap cleanup EXIT

wait_for_task_stop() {
  local task_arn="$1"
  local label="$2"
  local max_wait_secs="$3"
  local elapsed=0
  local task_json last_status

  while (( elapsed < max_wait_secs )); do
    task_json="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task_arn")"
    if [[ "$(jq '.failures | length' <<<"$task_json")" != "0" ]]; then
      echo "::error::ECS could not describe $label task $task_arn."
      jq '.failures' <<<"$task_json"
      return 1
    fi
    last_status="$(jq -r '.tasks[0].lastStatus // "MISSING"' <<<"$task_json")"
    echo "($elapsed s) $label task status=$last_status"
    if [[ "$last_status" == "STOPPED" ]]; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done

  echo "::error::$label task did not stop within ${max_wait_secs}s. The deploy role cannot call ecs:StopTask; task $task_arn may still be running."
  return 1
}

wait_for_service_rollout() {
  local task_definition="$1"
  local label="$2"
  local elapsed=0
  local deployment_json="$service_json"
  local deployment_state rollout_state running desired service_desired

  while (( elapsed < MAX_WAIT_SECS )); do
    if ! deployment_json="$(aws ecs describe-services \
      --cluster "$CLUSTER" \
      --services "$APP")"; then
      echo "::warning::Unable to inspect the $label rollout; retrying."
      sleep "$POLL_INTERVAL"
      elapsed=$((elapsed + POLL_INTERVAL))
      continue
    fi
    if [[ "$(jq '.failures | length' <<<"$deployment_json")" != "0" ]]; then
      echo "::warning::ECS returned a failure while inspecting the $label rollout; retrying."
      sleep "$POLL_INTERVAL"
      elapsed=$((elapsed + POLL_INTERVAL))
      continue
    fi
    if ! deployment_state="$(jq -r --arg task "$task_definition" '
      .services[0] as $service
      |
      [
        $service.deployments[]
        | select(.taskDefinition == $task and .status == "PRIMARY")
        | [.rolloutState, .runningCount, .desiredCount, $service.desiredCount]
        | @tsv
      ][0] // empty
    ' <<<"$deployment_json")"; then
      echo "::warning::ECS returned malformed rollout data for $label; retrying."
      sleep "$POLL_INTERVAL"
      elapsed=$((elapsed + POLL_INTERVAL))
      continue
    fi

    if [[ -z "$deployment_state" ]]; then
      echo "($elapsed s) waiting for the $label PRIMARY deployment"
    else
      IFS=$'\t' read -r rollout_state running desired service_desired <<<"$deployment_state"
      echo "($elapsed s) $label rolloutState=$rollout_state running=$running desired=$desired serviceDesired=$service_desired"
      if ! [[ "$running" =~ ^[0-9]+$ &&
              "$desired" =~ ^[0-9]+$ &&
              "$service_desired" =~ ^[0-9]+$ ]]; then
        echo "::warning::ECS returned non-numeric task counts for the $label rollout; retrying."
      elif (( service_desired < 1 )) && [[ "$zero_desired_count_allowed" != true ]]; then
        echo "::error::ECS service $APP reached desiredCount=0 during the $label rollout."
        return 1
      elif [[ "$rollout_state" == "COMPLETED" ]]; then
        # Both zero-checks need the same exemption. Under an authorised
        # zero-count deploy the steady state genuinely IS zero tasks, so a
        # bypass applied only to the pre-check would let the release start and
        # then kill it mid-rollout — later, and harder to read, than refusing up
        # front.
        if (( desired < 1 )) && [[ "$zero_desired_count_allowed" != true ]]; then
          echo "::error::ECS $label rollout for $APP completed at desiredCount=0; refusing to accept a zero-task steady state."
          return 1
        fi
        if (( desired < 1 )); then
          echo "$label rollout for $APP completed at desiredCount=0, as authorised."
          return 0
        fi
        if [[ "$running" == "$desired" ]]; then
          return 0
        fi
      elif (( desired < 1 )); then
        echo "::warning::ECS has not assigned desired tasks to the $label PRIMARY deployment yet; waiting."
      fi
      if [[ "$rollout_state" == "FAILED" ]]; then
        echo "::error::ECS $label rollout for $APP failed."
        echo "::group::Recent ECS service events"
        jq -r '
          .services[0].events[:10][]?
          | "\(.createdAt // "unknown") \(.message // "unknown")"
        ' <<<"$deployment_json"
        echo "::endgroup::"
        return 1
      fi
    fi

    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done

  echo "::error::ECS $label rollout for $APP did not complete within ${MAX_WAIT_SECS}s."
  echo "::group::Recent ECS service events"
  jq -r '
    .services[0].events[:10][]?
    | "\(.createdAt // "unknown") \(.message // "unknown")"
  ' <<<"$deployment_json"
  echo "::endgroup::"
  return 1
}

print_one_shot_logs() {
  local task_arn="$1"
  local label="$2"
  local task_id log_group log_stream_prefix log_stream log_json

  task_id="${task_arn##*/}"
  log_group="$(jq -r --arg name "$CONTAINER_NAME" '
    .containerDefinitions[]
    | select(.name == $name)
    | .logConfiguration.options["awslogs-group"] // empty
  ' "$rendered_task_definition_file")"
  log_stream_prefix="$(jq -r --arg name "$CONTAINER_NAME" '
    .containerDefinitions[]
    | select(.name == $name)
    | .logConfiguration.options["awslogs-stream-prefix"] // empty
  ' "$rendered_task_definition_file")"

  if [[ -z "$task_id" || -z "$log_group" || -z "$log_stream_prefix" ]]; then
    echo "::warning::Unable to derive the CloudWatch log stream for failed $label task $task_arn."
    return 0
  fi

  log_stream="$log_stream_prefix/$CONTAINER_NAME/$task_id"
  if ! log_json="$(aws logs get-log-events \
    --log-group-name "$log_group" \
    --log-stream-name "$log_stream" \
    --limit 200 \
    --start-from-head)"; then
    echo "::warning::Unable to read CloudWatch logs for failed $label task $task_arn."
    return 0
  fi

  echo "::group::$label CloudWatch logs"
  jq -r '.events[]?.message' <<<"$log_json"
  echo "::endgroup::"
}

run_one_shot_command() {
  local label="$1"
  local command_json="$2"
  local overrides run_json task_json exit_code stopped_reason container_reason

  overrides="$(jq -cn \
    --arg name "$CONTAINER_NAME" \
    --argjson command "$command_json" \
    '{
      containerOverrides: [{
        name: $name,
        command: $command
      }]
    }')"

  if ! run_json="$(aws "${one_shot_run_task_args[@]}" --overrides "$overrides")"; then
    echo "::error::ECS failed to start the $label task."
    return 1
  fi
  if [[ "$(jq '.failures | length' <<<"$run_json")" != "0" ]]; then
    echo "::error::ECS refused to start the $label task."
    jq '.failures' <<<"$run_json"
    return 1
  fi

  active_one_shot_task_arn="$(jq -r '.tasks[0].taskArn // empty' <<<"$run_json")"
  if [[ -z "$active_one_shot_task_arn" ]]; then
    echo "::error::ECS returned no task ARN for $label."
    return 1
  fi
  active_one_shot_label="$label"
  active_one_shot_task_stopped=false

  echo "Running $label with $new_task_definition"
  if ! wait_for_task_stop "$active_one_shot_task_arn" "$label" "$MAX_WAIT_SECS"; then
    return 1
  fi
  active_one_shot_task_stopped=true

  task_json="$(aws ecs describe-tasks \
    --cluster "$CLUSTER" \
    --tasks "$active_one_shot_task_arn")"
  exit_code="$(jq -r --arg name "$CONTAINER_NAME" '
    .tasks[0].containers[] | select(.name == $name) | .exitCode // -1
  ' <<<"$task_json")"
  if [[ "$exit_code" != "0" ]]; then
    print_one_shot_logs "$active_one_shot_task_arn" "$label"
    stopped_reason="$(jq -r '.tasks[0].stoppedReason // "unknown"' <<<"$task_json")"
    container_reason="$(jq -r --arg name "$CONTAINER_NAME" '
      .tasks[0].containers[] | select(.name == $name) | .reason // "unknown"
    ' <<<"$task_json")"
    echo "::error::$label task failed (exit=$exit_code, stopped=$stopped_reason, container=$container_reason)."
    return 1
  fi
  echo "$label completed successfully"
}

rollback_service() {
  echo "::warning::Rolling $APP back to $current_task_definition."
  if ! aws ecs update-service \
    --cluster "$CLUSTER" \
    --service "$APP" \
    --task-definition "$current_task_definition" \
    --desired-count "$service_desired_count" \
    --deployment-configuration '{
      "deploymentCircuitBreaker": {"enable": true, "rollback": true},
      "minimumHealthyPercent": 100,
      "maximumPercent": 200
    }' \
    >/dev/null; then
    echo "::error::ECS rejected the rollback to $current_task_definition."
    return 1
  fi
  wait_for_service_rollout "$current_task_definition" "rollback"
}

internal_metrics_secret_arn=""
if [[ -n "$INTERNAL_METRICS_PARAMETER" ]]; then
  if [[ "$INTERNAL_METRICS_PARAMETER" == arn:* ]]; then
    internal_metrics_secret_arn="$INTERNAL_METRICS_PARAMETER"
  else
    if [[ ! "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]; then
      echo "::error::AWS_ACCOUNT_ID must be a 12-digit account id when INTERNAL_METRICS_PARAMETER is a parameter name."
      exit 1
    fi
    # The hyphen is LAST on purpose. This is a POSIX bracket expression, where a
    # backslash is an ordinary character rather than an escape, so the `\-/` that
    # reads as an escaped hyphen in PCRE is really a reversed `\`-to-`/` range and
    # the class then matches no hyphen at all. Every `/oxy/<app>/...` parameter
    # path whose app name contains one was silently rejected.
    if [[ ! "$AWS_PARTITION" =~ ^aws(-[a-z]+)?$ ||
          ! "$INTERNAL_METRICS_PARAMETER" =~ ^/[A-Za-z0-9_./-]+$ ]]; then
      echo "::error::AWS partition or INTERNAL_METRICS_PARAMETER name is invalid."
      exit 1
    fi
    internal_metrics_secret_arn="arn:${AWS_PARTITION}:ssm:${AWS_REGION}:${AWS_ACCOUNT_ID}:parameter/${INTERNAL_METRICS_PARAMETER#/}"
  fi
  if [[ ! "$internal_metrics_secret_arn" =~ ^arn:aws(-[a-z]+)?:ssm:[a-z0-9-]+:[0-9]{12}:parameter/.+$ ]]; then
    echo "::error::Unable to construct a valid SSM parameter ARN for the task definition."
    exit 1
  fi
fi

task_secret_overrides="$(jq -c '
  [
    to_entries[]
    | {name: .key, valueFrom: .value}
  ]
' <<<"$TASK_SECRET_OVERRIDES_JSON")"

aws ecs describe-task-definition \
  --task-definition "$current_task_definition" \
  --query taskDefinition \
  >"$task_definition_file"

container_matches="$(jq --arg name "$CONTAINER_NAME" '[.containerDefinitions[] | select(.name == $name)] | length' "$task_definition_file")"
if [[ "$container_matches" != "1" ]]; then
  available_containers="$(jq -r '[.containerDefinitions[].name] | join(", ")' "$task_definition_file")"
  echo "::error::Expected exactly one container named $CONTAINER_NAME; found $container_matches. Available: $available_containers"
  exit 1
fi

jq \
  --arg name "$CONTAINER_NAME" \
  --arg image "$IMAGE_URI" \
  --arg internalMetricsSecretArn "$internal_metrics_secret_arn" \
  --argjson taskSecretOverrides "$task_secret_overrides" \
  '
    del(
      .taskDefinitionArn,
      .revision,
      .status,
      .requiresAttributes,
      .compatibilities,
      .registeredAt,
      .registeredBy
    )
    | ($taskSecretOverrides | map(.name)) as $taskSecretNames
    | .containerDefinitions |= map(
        if .name == $name then
          .image = $image
          | if $internalMetricsSecretArn != "" then
              .secrets = (
                (.secrets // [])
                | map(select(.name != "INTERNAL_METRICS_TOKEN"))
                + [{
                    name: "INTERNAL_METRICS_TOKEN",
                    valueFrom: $internalMetricsSecretArn
                  }]
              )
              | .environment = (
                  (.environment // [])
                  | map(select(.name != "INTERNAL_METRICS_ENABLED"))
                  + [{name: "INTERNAL_METRICS_ENABLED", value: "true"}]
                )
            else .
            end
          | .secrets = (
              ((.secrets // [])
                | map(
                    select(
                      .name as $existingName
                      | ($taskSecretNames | index($existingName)) == null
                    )
                  ))
              + $taskSecretOverrides
            )
        else . end
      )
  ' \
  "$task_definition_file" >"$rendered_task_definition_file"

new_task_definition="$(aws ecs register-task-definition \
  --cli-input-json "file://$rendered_task_definition_file" \
  --query 'taskDefinition.taskDefinitionArn' \
  --output text)"

one_shot_run_task_args=()
if [[ "$RUN_MIGRATIONS" == "true" || -n "$POST_DEPLOY_TASK_COMMAND_JSON" ]]; then
  network_configuration="$(jq -c '.services[0].networkConfiguration' <<<"$service_json")"
  if [[ -z "$network_configuration" || "$network_configuration" == "null" ]]; then
    echo "::error::ECS service $APP has no network configuration for the migration task."
    exit 1
  fi

  one_shot_run_task_args=(
    ecs run-task
    --cluster "$CLUSTER"
    --task-definition "$new_task_definition"
    --count 1
    --network-configuration "$network_configuration"
  )

  capacity_provider_strategy="$(jq -c '.services[0].capacityProviderStrategy // []' <<<"$service_json")"
  if [[ "$capacity_provider_strategy" != "[]" ]]; then
    one_shot_run_task_args+=(--capacity-provider-strategy "$capacity_provider_strategy")
  else
    launch_type="$(jq -r '.services[0].launchType // "FARGATE"' <<<"$service_json")"
    one_shot_run_task_args+=(--launch-type "$launch_type")
    platform_version="$(jq -r '.services[0].platformVersion // empty' <<<"$service_json")"
    if [[ -n "$platform_version" ]]; then
      one_shot_run_task_args+=(--platform-version "$platform_version")
    fi
  fi
fi

if [[ "$RUN_MIGRATIONS" == "true" ]]; then
  # PROCESS SUBSTITUTION, NOT A PIPE, and the reason is not the obvious one.
  #
  # `set -e` catches the failing pipeline either way, so both forms do stop the
  # release before `update-service` — measured, so do not "simplify" this on the
  # theory that the pipe is equivalent. What a pipe loses is the loop body's
  # WRITES: it runs in a subshell, so `run_one_shot_command`'s
  # `active_one_shot_task_arn` / `_label` / `_stopped` never reach the parent,
  # and the EXIT trap reads their initial values. The warning that a migration
  # task may STILL BE RUNNING against the database after the deploy gave up —
  # the one thing telling an operator the schema may be moving under them, and
  # unrecoverable because the deploy role cannot call `ecs:StopTask` — silently
  # stops being emitted. The `migration-task-never-stops` case in
  # test-deploy-ecs-image.sh is what notices.
  while IFS= read -r migration_entry; do
    if ! run_one_shot_command \
      "$(jq -r '.label' <<<"$migration_entry")" \
      "$(jq -c '.command' <<<"$migration_entry")"; then
      exit 1
    fi
  done < <(jq -c '.[]' <<<"$MIGRATION_TASK_COMMANDS_JSON")
fi

if [[ -n "${DEPLOY_SHA:-}" ]]; then
  echo "Re-verifying origin/main immediately before the ECS service update."
  bash "$DEPLOY_HEAD_GUARD_SCRIPT"
fi

if ! aws ecs update-service \
  --cluster "$CLUSTER" \
  --service "$APP" \
  --task-definition "$new_task_definition" \
  --desired-count "$service_desired_count" \
  --deployment-configuration '{
    "deploymentCircuitBreaker": {"enable": true, "rollback": true},
    "minimumHealthyPercent": 100,
    "maximumPercent": 200
  }' \
  >/dev/null; then
  echo "::error::ECS rejected the service update; restoring the previous task definition defensively."
  if ! rollback_service; then
    echo "::error::The defensive rollback also failed; manual intervention is required."
  fi
  exit 1
fi

echo "Deploying immutable image $IMAGE_URI with task definition $new_task_definition"

if ! wait_for_service_rollout "$new_task_definition" "deployment"; then
  if ! rollback_service; then
    echo "::error::Deployment and explicit rollback both failed; manual intervention is required."
  fi
  exit 1
fi
echo "ECS rollout reached a healthy steady state at $new_task_definition"

if [[ -n "$POST_DEPLOY_SMOKE_SCRIPT" ]]; then
  echo "Running post-deploy smoke checks with $POST_DEPLOY_SMOKE_SCRIPT"
  smoke_exit=0
  bash "$POST_DEPLOY_SMOKE_SCRIPT" || smoke_exit=$?
  if (( smoke_exit == SMOKE_NO_ROLLBACK_EXIT )); then
    # The smoke script attributed every failure to something outside the image.
    # The release keeps going — including the reconciliation task below, which
    # would otherwise be skipped over a fault it has nothing to do with — and the
    # job fails at the end so the failure is still paged rather than swallowed.
    echo "::error::Post-deploy smoke checks failed only checks that a rollback cannot repair. $APP stays on $new_task_definition; investigate the dependency named above."
    smoke_reported_external_failure=true
  elif (( smoke_exit != 0 )); then
    echo "::error::Post-deploy smoke checks failed."
    if rollback_service; then
      echo "::warning::Rollback completed after smoke failure."
    else
      echo "::error::Rollback also failed; manual intervention is required."
    fi
    exit 1
  fi
fi

if [[ -n "$POST_DEPLOY_TASK_COMMAND_JSON" ]]; then
  if ! run_one_shot_command \
    "Post-deploy reconciliation" \
    "$POST_DEPLOY_TASK_COMMAND_JSON"; then
    echo "::error::Post-deploy reconciliation failed."
    if ! rollback_service; then
      echo "::error::Reconciliation and rollback both failed; manual intervention is required."
    fi
    exit 1
  fi
fi

if [[ "$smoke_reported_external_failure" == "true" ]]; then
  echo "::error::$APP is deployed and live at $new_task_definition, but its post-deploy smoke checks are still failing on a dependency. Nothing was rolled back; this release needs a human."
  exit 1
fi

echo "Deployed $APP at $new_task_definition"
