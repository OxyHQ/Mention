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
HEALTH_CHECK_PATH="${HEALTH_CHECK_PATH:-}"
EXPECTED_PRE_ROLLOUT_HEALTH_CHECK_PATH="${EXPECTED_PRE_ROLLOUT_HEALTH_CHECK_PATH:-}"
ENABLE_TARGET_STICKINESS="${ENABLE_TARGET_STICKINESS:-false}"
TARGET_STICKINESS_SECONDS="${TARGET_STICKINESS_SECONDS:-3600}"
INTERNAL_METRICS_PARAMETER="${INTERNAL_METRICS_PARAMETER:-}"
TASK_SECRET_OVERRIDES_JSON="${TASK_SECRET_OVERRIDES_JSON:-}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-}"
AWS_PARTITION="${AWS_PARTITION:-aws}"
POST_DEPLOY_SMOKE_SCRIPT="${POST_DEPLOY_SMOKE_SCRIPT:-}"
POST_DEPLOY_TASK_COMMAND_JSON="${POST_DEPLOY_TASK_COMMAND_JSON:-}"
DEPLOY_HEAD_GUARD_SCRIPT="${DEPLOY_HEAD_GUARD_SCRIPT:-.github/scripts/require-current-main.sh}"
CAN_STOP_ONE_SHOT_TASKS="${CAN_STOP_ONE_SHOT_TASKS:-false}"

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
if [[ "$ENABLE_TARGET_STICKINESS" != "true" &&
      "$ENABLE_TARGET_STICKINESS" != "false" ]]; then
  echo "::error::ENABLE_TARGET_STICKINESS must be either 'true' or 'false'."
  exit 1
fi
if [[ "$CAN_STOP_ONE_SHOT_TASKS" != "true" &&
      "$CAN_STOP_ONE_SHOT_TASKS" != "false" ]]; then
  echo "::error::CAN_STOP_ONE_SHOT_TASKS must be either 'true' or 'false'."
  exit 1
fi
validate_health_check_path() {
  local variable_name="$1"
  local path="$2"

  if [[ -n "$path" ]] &&
     { [[ "$path" != /* ]] ||
       [[ "${#path}" -gt 1024 ]] ||
       [[ "$path" =~ [[:space:][:cntrl:]] ]]; }; then
    echo "::error::$variable_name must be a slash-prefixed URI path without whitespace or control characters (maximum 1024 characters)."
    return 1
  fi
}

validate_health_check_path "HEALTH_CHECK_PATH" "$HEALTH_CHECK_PATH"
validate_health_check_path \
  "EXPECTED_PRE_ROLLOUT_HEALTH_CHECK_PATH" \
  "$EXPECTED_PRE_ROLLOUT_HEALTH_CHECK_PATH"
if [[ "$ENABLE_TARGET_STICKINESS" == "true" ]] &&
   { ! [[ "$TARGET_STICKINESS_SECONDS" =~ ^[0-9]+$ ]] ||
     (( TARGET_STICKINESS_SECONDS < 1 || TARGET_STICKINESS_SECONDS > 604800 )); }; then
  echo "::error::TARGET_STICKINESS_SECONDS must be an integer between 1 and 604800."
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
        test("^arn:aws(-[a-z]+)?:ssm:[a-z0-9-]+:[0-9]{12}:parameter/[A-Za-z0-9_.\\-/]+$")
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

task_definition_file="$(mktemp)"
rendered_task_definition_file="$(mktemp)"
active_one_shot_task_arn=""
active_one_shot_task_stopped=true
active_one_shot_label=""
release_succeeded=false
target_group_configuration_dirty=false
declare -a target_group_arns=()
declare -A previous_health_check_paths=()
declare -A previous_stickiness_enabled=()
declare -A previous_stickiness_types=()
declare -A previous_stickiness_durations=()

cleanup() {
  if [[ "$active_one_shot_task_stopped" != "true" &&
        -n "$active_one_shot_task_arn" ]]; then
    if [[ "$CAN_STOP_ONE_SHOT_TASKS" == "true" ]]; then
      echo "::warning::Stopping unfinished $active_one_shot_label task $active_one_shot_task_arn."
      aws ecs stop-task \
        --cluster "$CLUSTER" \
        --task "$active_one_shot_task_arn" \
        --reason "Deployment workflow ended before one-shot task completion" \
        >/dev/null 2>&1 || true
    else
      echo "::warning::Unfinished $active_one_shot_label task $active_one_shot_task_arn may still be running; the deploy role cannot call ecs:StopTask."
    fi
  fi
  if [[ "$release_succeeded" != "true" &&
        "$target_group_configuration_dirty" == "true" ]]; then
    echo "::warning::Restoring target-group configuration during deployment cleanup."
    restore_target_group_configuration >/dev/null 2>&1 || true
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

  if [[ "$CAN_STOP_ONE_SHOT_TASKS" != "true" ]]; then
    echo "::error::$label task did not stop within ${max_wait_secs}s. The deploy role cannot call ecs:StopTask; task $task_arn may still be running."
    return 1
  fi

  echo "::error::$label task did not stop within ${max_wait_secs}s; stopping it before failing."
  aws ecs stop-task \
    --cluster "$CLUSTER" \
    --task "$task_arn" \
    --reason "$label exceeded deployment timeout" \
    >/dev/null || true

  elapsed=0
  while (( elapsed < 120 )); do
    last_status="$(aws ecs describe-tasks \
      --cluster "$CLUSTER" \
      --tasks "$task_arn" \
      --query 'tasks[0].lastStatus' \
      --output text)"
    [[ "$last_status" == "STOPPED" ]] && return 1
    sleep 5
    elapsed=$((elapsed + 5))
  done
  echo "::error::$label task is still running after the stop request."
  return 1
}

wait_for_service_rollout() {
  local task_definition="$1"
  local label="$2"
  local elapsed=0
  local deployment_json="$service_json"
  local deployment_state rollout_state running desired

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
      [
        .services[0].deployments[]
        | select(.taskDefinition == $task and .status == "PRIMARY")
        | [.rolloutState, .runningCount, .desiredCount]
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
      IFS=$'\t' read -r rollout_state running desired <<<"$deployment_state"
      echo "($elapsed s) $label rolloutState=$rollout_state running=$running desired=$desired"
      if [[ "$rollout_state" == "COMPLETED" && "$running" == "$desired" ]]; then
        return 0
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

prevalidate_target_group_configuration() {
  local target_group target_group_json target_group_count
  local health_check_protocol health_check_enabled health_check_path
  local load_balancer_arn load_balancer_json load_balancer_count
  local attributes_json attribute_value
  declare -A seen_target_groups=()

  if [[ -z "$HEALTH_CHECK_PATH" &&
        -z "$EXPECTED_PRE_ROLLOUT_HEALTH_CHECK_PATH" &&
        "$ENABLE_TARGET_STICKINESS" != "true" ]]; then
    return 0
  fi

  while IFS= read -r target_group; do
    [[ -z "$target_group" || -n "${seen_target_groups[$target_group]:-}" ]] &&
      continue
    seen_target_groups["$target_group"]=true
    target_group_arns+=("$target_group")
  done < <(jq -r '.services[0].loadBalancers[]?.targetGroupArn // empty' <<<"$service_json")

  if (( ${#target_group_arns[@]} == 0 )); then
    echo "::error::ECS service $APP has no target group to configure."
    return 1
  fi

  for target_group in "${target_group_arns[@]}"; do
    if ! target_group_json="$(aws elbv2 describe-target-groups \
      --target-group-arns "$target_group")"; then
      echo "::error::Unable to inspect target group $target_group."
      return 1
    fi
    target_group_count="$(jq '.TargetGroups | length' <<<"$target_group_json")"
    if [[ "$target_group_count" != "1" ]]; then
      echo "::error::Expected exactly one target group for $target_group; found $target_group_count."
      return 1
    fi

    if [[ -n "$HEALTH_CHECK_PATH" ||
          -n "$EXPECTED_PRE_ROLLOUT_HEALTH_CHECK_PATH" ]]; then
      health_check_protocol="$(jq -r '.TargetGroups[0].HealthCheckProtocol // empty' <<<"$target_group_json")"
      health_check_enabled="$(jq -r '.TargetGroups[0].HealthCheckEnabled // false' <<<"$target_group_json")"
      health_check_path="$(jq -r '.TargetGroups[0].HealthCheckPath // empty' <<<"$target_group_json")"
      if [[ "$health_check_protocol" != "HTTP" &&
            "$health_check_protocol" != "HTTPS" ]]; then
        echo "::error::Target group $target_group does not use HTTP(S) health checks."
        return 1
      fi
      if [[ "$health_check_enabled" != "true" || -z "$health_check_path" ]]; then
        echo "::error::Target group $target_group has no enabled health-check path to preserve."
        return 1
      fi
      previous_health_check_paths["$target_group"]="$health_check_path"
      if [[ -n "$EXPECTED_PRE_ROLLOUT_HEALTH_CHECK_PATH" &&
            "$health_check_path" != "$EXPECTED_PRE_ROLLOUT_HEALTH_CHECK_PATH" &&
            "$health_check_path" != "$HEALTH_CHECK_PATH" ]]; then
        echo "::error::Target group $target_group uses pre-rollout health-check path $health_check_path; expected legacy path $EXPECTED_PRE_ROLLOUT_HEALTH_CHECK_PATH or final path $HEALTH_CHECK_PATH. Refusing to run migrations or update the service."
        return 1
      fi
    fi

    if [[ "$ENABLE_TARGET_STICKINESS" == "true" ]]; then
      if [[ "$(jq '.TargetGroups[0].LoadBalancerArns | length' <<<"$target_group_json")" == "0" ]]; then
        echo "::error::Target group $target_group is not attached to a load balancer."
        return 1
      fi
      while IFS= read -r load_balancer_arn; do
        [[ -z "$load_balancer_arn" ]] && continue
        if ! load_balancer_json="$(aws elbv2 describe-load-balancers \
          --load-balancer-arns "$load_balancer_arn")"; then
          echo "::error::Unable to inspect load balancer for $target_group."
          return 1
        fi
        load_balancer_count="$(jq '.LoadBalancers | length' <<<"$load_balancer_json")"
        if [[ "$load_balancer_count" != "1" ||
              "$(jq -r '.LoadBalancers[0].Type // empty' <<<"$load_balancer_json")" != "application" ]]; then
          echo "::error::lb_cookie stickiness requires an application load balancer for $target_group."
          return 1
        fi
      done < <(jq -r '.TargetGroups[0].LoadBalancerArns[]' <<<"$target_group_json")

      if ! attributes_json="$(aws elbv2 describe-target-group-attributes \
        --target-group-arn "$target_group")"; then
        echo "::error::Unable to inspect attributes for target group $target_group."
        return 1
      fi
      attribute_value="$(jq -r '.Attributes[] | select(.Key == "stickiness.enabled") | .Value' <<<"$attributes_json")"
      if [[ -z "$attribute_value" ]]; then
        echo "::error::Target group $target_group does not expose stickiness.enabled."
        return 1
      fi
      previous_stickiness_enabled["$target_group"]="$attribute_value"

      attribute_value="$(jq -r '.Attributes[] | select(.Key == "stickiness.type") | .Value' <<<"$attributes_json")"
      if [[ -z "$attribute_value" ]]; then
        echo "::error::Target group $target_group does not expose stickiness.type."
        return 1
      fi
      previous_stickiness_types["$target_group"]="$attribute_value"

      attribute_value="$(jq -r '.Attributes[] | select(.Key == "stickiness.lb_cookie.duration_seconds") | .Value' <<<"$attributes_json")"
      if [[ -z "$attribute_value" ]]; then
        echo "::error::Target group $target_group does not expose lb_cookie duration."
        return 1
      fi
      previous_stickiness_durations["$target_group"]="$attribute_value"
    fi
  done

  echo "Prevalidated ${#target_group_arns[@]} target group(s) and captured their previous configuration."
}

restore_target_group_configuration() {
  local target_group
  local restore_failed=false

  if [[ "$target_group_configuration_dirty" != "true" ]]; then
    return 0
  fi

  for target_group in "${target_group_arns[@]}"; do
    if [[ "$ENABLE_TARGET_STICKINESS" == "true" ]]; then
      if ! aws elbv2 modify-target-group-attributes \
        --target-group-arn "$target_group" \
        --attributes \
          Key=stickiness.enabled,Value="${previous_stickiness_enabled[$target_group]}" \
          Key=stickiness.type,Value="${previous_stickiness_types[$target_group]}" \
          Key=stickiness.lb_cookie.duration_seconds,Value="${previous_stickiness_durations[$target_group]}" \
        >/dev/null; then
        echo "::error::Failed to restore stickiness attributes for $target_group."
        restore_failed=true
      fi
    fi
    if [[ -n "$HEALTH_CHECK_PATH" ]]; then
      if ! aws elbv2 modify-target-group \
        --target-group-arn "$target_group" \
        --health-check-path "${previous_health_check_paths[$target_group]}" \
        >/dev/null; then
        echo "::error::Failed to restore the health-check path for $target_group."
        restore_failed=true
      fi
    fi
  done

  if [[ "$restore_failed" == "true" ]]; then
    return 1
  fi
  target_group_configuration_dirty=false
  echo "Restored the previous target-group configuration."
}

apply_target_group_configuration() {
  local target_group

  for target_group in "${target_group_arns[@]}"; do
    if [[ -n "$HEALTH_CHECK_PATH" &&
          "${previous_health_check_paths[$target_group]}" != "$HEALTH_CHECK_PATH" ]]; then
      target_group_configuration_dirty=true
      if ! aws elbv2 modify-target-group \
        --target-group-arn "$target_group" \
        --health-check-path "$HEALTH_CHECK_PATH" \
        >/dev/null; then
        echo "::error::Failed to configure the health-check path for $target_group."
        return 1
      fi
      echo "Configured $target_group health check path as $HEALTH_CHECK_PATH"
    fi

    if [[ "$ENABLE_TARGET_STICKINESS" == "true" ]] &&
       { [[ "${previous_stickiness_enabled[$target_group]}" != "true" ]] ||
         [[ "${previous_stickiness_types[$target_group]}" != "lb_cookie" ]] ||
         [[ "${previous_stickiness_durations[$target_group]}" != "$TARGET_STICKINESS_SECONDS" ]]; }; then
      target_group_configuration_dirty=true
      if ! aws elbv2 modify-target-group-attributes \
        --target-group-arn "$target_group" \
        --attributes \
          Key=stickiness.enabled,Value=true \
          Key=stickiness.type,Value=lb_cookie \
          Key=stickiness.lb_cookie.duration_seconds,Value="$TARGET_STICKINESS_SECONDS" \
        >/dev/null; then
        echo "::error::Failed to configure stickiness for $target_group."
        return 1
      fi
      echo "Enabled load-balancer stickiness on $target_group"
    fi
  done
}

rollback_release() {
  local rollback_failed=false

  if ! restore_target_group_configuration; then
    echo "::error::Target-group restoration failed; manual intervention is required."
    rollback_failed=true
  fi
  if ! rollback_service; then
    echo "::error::Service rollback failed; manual intervention is required."
    rollback_failed=true
  fi

  [[ "$rollback_failed" == "false" ]]
}

prevalidate_target_group_configuration

internal_metrics_secret_arn=""
if [[ -n "$INTERNAL_METRICS_PARAMETER" ]]; then
  if [[ "$INTERNAL_METRICS_PARAMETER" == arn:* ]]; then
    internal_metrics_secret_arn="$INTERNAL_METRICS_PARAMETER"
  else
    if [[ ! "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]; then
      echo "::error::AWS_ACCOUNT_ID must be a 12-digit account id when INTERNAL_METRICS_PARAMETER is a parameter name."
      exit 1
    fi
    if [[ ! "$AWS_PARTITION" =~ ^aws(-[a-z]+)?$ ||
          ! "$INTERNAL_METRICS_PARAMETER" =~ ^/[A-Za-z0-9_.\-/]+$ ]]; then
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
  if ! run_one_shot_command \
    "Migration" \
    '["bun","packages/backend/dist/scripts/migrate.js"]'; then
    exit 1
  fi
fi

if [[ -n "${DEPLOY_SHA:-}" ]]; then
  echo "Re-verifying origin/main immediately before the ECS service update."
  bash "$DEPLOY_HEAD_GUARD_SCRIPT"
fi

if ! aws ecs update-service \
  --cluster "$CLUSTER" \
  --service "$APP" \
  --task-definition "$new_task_definition" \
  --deployment-configuration '{
    "deploymentCircuitBreaker": {"enable": true, "rollback": true},
    "minimumHealthyPercent": 100,
    "maximumPercent": 200
  }' \
  >/dev/null; then
  echo "::error::ECS rejected the service update; restoring the previous task definition defensively."
  if ! rollback_release; then
    echo "::error::The defensive rollback also failed; manual intervention is required."
  fi
  exit 1
fi

echo "Deploying immutable image $IMAGE_URI with task definition $new_task_definition"

if ! wait_for_service_rollout "$new_task_definition" "deployment"; then
  if ! rollback_release; then
    echo "::error::Deployment and explicit rollback both failed; manual intervention is required."
  fi
  exit 1
fi
echo "ECS rollout reached a healthy steady state at $new_task_definition"

if [[ -n "$POST_DEPLOY_SMOKE_SCRIPT" ]]; then
  echo "Running post-deploy smoke checks with $POST_DEPLOY_SMOKE_SCRIPT"
  if ! bash "$POST_DEPLOY_SMOKE_SCRIPT"; then
    echo "::error::Post-deploy smoke checks failed."
    if rollback_release; then
      echo "::warning::Rollback completed after smoke failure."
    else
      echo "::error::Rollback also failed; manual intervention is required."
    fi
    exit 1
  fi
fi

if ! apply_target_group_configuration; then
  echo "::error::Target-group configuration failed after rollout."
  if rollback_release; then
    echo "::warning::Target groups and ECS service were restored after the configuration failure."
  else
    echo "::error::Target-group configuration rollback was incomplete; manual intervention is required."
  fi
  exit 1
fi

if [[ -n "$POST_DEPLOY_TASK_COMMAND_JSON" ]]; then
  if ! run_one_shot_command \
    "Post-deploy reconciliation" \
    "$POST_DEPLOY_TASK_COMMAND_JSON"; then
    echo "::error::Post-deploy reconciliation failed."
    if ! rollback_release; then
      echo "::error::Reconciliation and rollback both failed; manual intervention is required."
    fi
    exit 1
  fi
fi

release_succeeded=true
echo "Deployed $APP at $new_task_definition"
