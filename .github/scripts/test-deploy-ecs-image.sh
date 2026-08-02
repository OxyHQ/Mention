#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_directory="$(mktemp -d)"
temporary_root="$(realpath "${TMPDIR:-/tmp}")"
test_directory="$(realpath "$test_directory")"

cleanup_test_directory() {
  if [[ "$test_directory" == "$temporary_root/"* &&
        -d "$test_directory" ]]; then
    rm -rf -- "$test_directory"
  else
    echo "Refusing to remove unexpected test directory: $test_directory" >&2
  fi
}
trap cleanup_test_directory EXIT

export DEPLOY_TEST_LOG=""
export DEPLOY_TEST_EXPECT_METRICS_ARN=false
# The SSM parameter path a case feeds to INTERNAL_METRICS_PARAMETER, and from
# which the mocked register-task-definition derives the ARN it demands. A case
# overrides it to cover a path shape the default does not.
export DEPLOY_TEST_METRICS_PARAMETER=/oxy/mention/INTERNAL_METRICS_TOKEN
export DEPLOY_TEST_TASK_EXIT_CODE=0
export DEPLOY_TEST_EXPECT_TASK_SECRET_ARN=false
export DEPLOY_TEST_SERVICE_DESIRED_COUNT=1
export DEPLOY_TEST_ROLLOUT_SCENARIO=healthy

aws() {
  local service_json='{
    "failures": [],
    "services": [{
      "status": "ACTIVE",
      "taskDefinition": "arn:aws:ecs:test:task-definition/mention-test:1",
      "desiredCount": 1,
      "networkConfiguration": {
        "awsvpcConfiguration": {
          "subnets": ["subnet-test"],
          "securityGroups": ["sg-test"]
        }
      },
      "launchType": "FARGATE",
      "deployments": [
        {
          "taskDefinition": "arn:aws:ecs:test:task-definition/mention-test:2",
          "status": "PRIMARY",
          "rolloutState": "COMPLETED",
          "runningCount": 1,
          "desiredCount": 1
        },
        {
          "taskDefinition": "arn:aws:ecs:test:task-definition/mention-test:1",
          "status": "PRIMARY",
          "rolloutState": "COMPLETED",
          "runningCount": 1,
          "desiredCount": 1
        }
      ]
    }]
  }'
  service_json="$(jq \
    --argjson desired "$DEPLOY_TEST_SERVICE_DESIRED_COUNT" \
    '.services[0].desiredCount = $desired' \
    <<<"$service_json")"

  case "$1 $2" in
    "ecs describe-services")
      local describe_count_file="${DEPLOY_TEST_LOG}.describe-count"
      local describe_count=0
      if [[ -f "$describe_count_file" ]]; then
        describe_count="$(<"$describe_count_file")"
      fi
      describe_count=$((describe_count + 1))
      printf '%s\n' "$describe_count" >"$describe_count_file"
      if [[ "$DEPLOY_TEST_ROLLOUT_SCENARIO" == "transient-zero-deployment" &&
            "$describe_count" == "2" ]]; then
        service_json="$(jq '
          .services[0].deployments |= map(
              if .taskDefinition == "arn:aws:ecs:test:task-definition/mention-test:2"
              then
                .rolloutState = "IN_PROGRESS"
                | .desiredCount = 0
                | .runningCount = 0
              else .
              end
            )
        ' <<<"$service_json")"
      elif [[ "$DEPLOY_TEST_ROLLOUT_SCENARIO" == "zero-service-during-deploy" &&
              "$describe_count" == "2" ]]; then
        service_json="$(jq '
          .services[0].desiredCount = 0
          | .services[0].deployments |= map(
              if .taskDefinition == "arn:aws:ecs:test:task-definition/mention-test:2"
              then .desiredCount = 0 | .runningCount = 0
              else .
              end
            )
        ' <<<"$service_json")"
      elif [[ "$DEPLOY_TEST_ROLLOUT_SCENARIO" == "completed-zero-deployment" &&
              "$describe_count" == "2" ]]; then
        service_json="$(jq '
          .services[0].deployments |= map(
              if .taskDefinition == "arn:aws:ecs:test:task-definition/mention-test:2"
              then .desiredCount = 0 | .runningCount = 0
              else .
              end
            )
        ' <<<"$service_json")"
      fi
      printf '%s\n' "$service_json"
      ;;
    "ecs describe-task-definition")
      printf '%s\n' '{
        "family": "mention-test",
        "networkMode": "awsvpc",
        "requiresCompatibilities": ["FARGATE"],
        "cpu": "256",
        "memory": "512",
        "containerDefinitions": [{
          "name": "mention-test",
          "image": "example.invalid/mention-test:old",
          "essential": true,
          "logConfiguration": {
            "logDriver": "awslogs",
            "options": {
              "awslogs-group": "/ecs/mention-test",
              "awslogs-stream-prefix": "ecs"
            }
          }
        }]
      }'
      ;;
    "ecs register-task-definition")
      if [[ "$DEPLOY_TEST_EXPECT_METRICS_ARN" == "true" ]]; then
        local previous_argument=""
        local input_json=""
        local argument
        for argument in "$@"; do
          if [[ "$previous_argument" == "--cli-input-json" ]]; then
            input_json="${argument#file://}"
            break
          fi
          previous_argument="$argument"
        done
        # The verdict is written to the log rather than left to `set -e`. A
        # command that fails in the MIDDLE of this function does not abort the
        # run -- measured, and it holds whether the function is exported or
        # local -- because the caller consumes it as `v="$(aws ...)"` and only
        # the function's LAST command reaches that assignment's exit status. An
        # assertion whose only effect is its own exit status therefore cannot
        # fail, which is what this one did: pointing it at an ARN no case uses
        # left the suite green. Logging a distinct token instead puts the
        # mismatch in the expected.log diff, where it names itself.
        if jq -e \
          --arg expected \
          "arn:aws:ssm:test:123456789012:parameter${DEPLOY_TEST_METRICS_PARAMETER}" \
          '
          .containerDefinitions[]
          | select(.name == "mention-test")
          | .secrets[]
          | select(
              .name == "INTERNAL_METRICS_TOKEN" and
              .valueFrom == $expected
            )
        ' "$input_json" >/dev/null; then
          printf 'metrics:arn\n' >>"$DEPLOY_TEST_LOG"
        else
          printf 'metrics:arn:MISMATCH\n' >>"$DEPLOY_TEST_LOG"
        fi
      fi
      if [[ "$DEPLOY_TEST_EXPECT_TASK_SECRET_ARN" == "true" ]]; then
        local previous_argument=""
        local input_json=""
        local argument
        for argument in "$@"; do
          if [[ "$previous_argument" == "--cli-input-json" ]]; then
            input_json="${argument#file://}"
            break
          fi
          previous_argument="$argument"
        done
        # Same reason as the metrics assertion above: log the verdict, do not
        # rely on this function's exit status.
        if jq -e '
          .containerDefinitions[]
          | select(.name == "mention-test")
          | .secrets[]
          | select(
              .name == "MENTION_MCP_JWT_SECRET" and
              .valueFrom == "arn:aws:ssm:test:123456789012:parameter/oxy/mention-mcp/MENTION_MCP_JWT_SECRET"
            )
        ' "$input_json" >/dev/null; then
          printf 'task-secret:arn\n' >>"$DEPLOY_TEST_LOG"
        else
          printf 'task-secret:arn:MISMATCH\n' >>"$DEPLOY_TEST_LOG"
        fi
      fi
      printf '%s\n' "arn:aws:ecs:test:task-definition/mention-test:2"
      ;;
    "ecs update-service")
      local previous_argument=""
      local task_definition=""
      local desired_count=""
      local argument
      for argument in "$@"; do
        if [[ "$previous_argument" == "--task-definition" ]]; then
          task_definition="$argument"
        elif [[ "$previous_argument" == "--desired-count" ]]; then
          desired_count="$argument"
        fi
        previous_argument="$argument"
      done
      if [[ -z "$desired_count" ]]; then
        echo "Mocked update-service requires an explicit --desired-count." >&2
        return 1
      fi
      printf 'service:%s:desired=%s\n' \
        "$task_definition" \
        "$desired_count" \
        >>"$DEPLOY_TEST_LOG"
      printf '{}\n'
      ;;
    "ecs run-task")
      printf 'reconcile\n' >>"$DEPLOY_TEST_LOG"
      printf '%s\n' '{
        "failures": [],
        "tasks": [{"taskArn": "arn:aws:ecs:test:task/mention-reconcile"}]
      }'
      ;;
    "ecs describe-tasks")
      printf '{
        "failures": [],
        "tasks": [{
          "lastStatus": "STOPPED",
          "stoppedReason": "Essential container exited",
          "containers": [{
            "name": "mention-test",
            "exitCode": %s
          }]
        }]
      }\n' "$DEPLOY_TEST_TASK_EXIT_CODE"
      ;;
    "logs get-log-events")
      printf 'tasklogs\n' >>"$DEPLOY_TEST_LOG"
      printf '%s\n' '{
        "events": [{
          "message": "[migration] fixture failure"
        }]
      }'
      ;;
    *)
      printf 'Unexpected mocked AWS call: %s\n' "$*" >&2
      return 1
      ;;
  esac
}
export -f aws

run_release() {
  local case_name="$1"
  local expect_success="$2"
  local run_migrations="${3:-false}"
  local inject_internal_metrics="${4:-false}"
  local task_exit_code="${5:-0}"
  local inject_task_secret="${6:-false}"
  local service_desired_count="${7:-1}"
  local rollout_scenario="${8:-healthy}"
  local case_directory="$test_directory/$case_name"
  local output_file="$case_directory/output.log"
  local smoke_script="$case_directory/smoke.sh"

  mkdir -p "$case_directory"
  DEPLOY_TEST_LOG="$case_directory/aws.log"
  DEPLOY_TEST_EXPECT_METRICS_ARN="$inject_internal_metrics"
  DEPLOY_TEST_TASK_EXIT_CODE="$task_exit_code"
  DEPLOY_TEST_EXPECT_TASK_SECRET_ARN="$inject_task_secret"
  DEPLOY_TEST_SERVICE_DESIRED_COUNT="$service_desired_count"
  DEPLOY_TEST_ROLLOUT_SCENARIO="$rollout_scenario"
  export DEPLOY_TEST_LOG DEPLOY_TEST_EXPECT_METRICS_ARN
  export DEPLOY_TEST_TASK_EXIT_CODE
  export DEPLOY_TEST_EXPECT_TASK_SECRET_ARN
  export DEPLOY_TEST_SERVICE_DESIRED_COUNT
  export DEPLOY_TEST_ROLLOUT_SCENARIO

  # The generated smoke fixture expands this variable when it runs.
  # shellcheck disable=SC2016
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "smoke\n" >>"$DEPLOY_TEST_LOG"' \
    >"$smoke_script"

  local -a release_environment=(
    AWS_REGION=test
    AWS_ACCOUNT_ID=123456789012
    CLUSTER=mention-test
    APP=mention-test
    CONTAINER_NAME=mention-test
    IMAGE_URI="example.invalid/mention-test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    MAX_WAIT_SECS=5
    POLL_INTERVAL=1
    RUN_MIGRATIONS="$run_migrations"
    POST_DEPLOY_SMOKE_SCRIPT="$smoke_script"
    POST_DEPLOY_TASK_COMMAND_JSON='["reconcile"]'
  )
  if [[ "$inject_internal_metrics" == "true" ]]; then
    release_environment+=(
      INTERNAL_METRICS_PARAMETER="$DEPLOY_TEST_METRICS_PARAMETER"
    )
  fi
  if [[ "$inject_task_secret" == "true" ]]; then
    release_environment+=(
      TASK_SECRET_OVERRIDES_JSON='{"MENTION_MCP_JWT_SECRET":"arn:aws:ssm:test:123456789012:parameter/oxy/mention-mcp/MENTION_MCP_JWT_SECRET"}'
    )
  fi

  if env "${release_environment[@]}" \
    bash "$repository_root/.github/scripts/deploy-ecs-image.sh" \
    >"$output_file" 2>&1; then
    if [[ "$expect_success" != "true" ]]; then
      echo "Expected $case_name to fail." >&2
      return 1
    fi
  elif [[ "$expect_success" == "true" ]]; then
    echo "Expected $case_name to succeed." >&2
    sed -n '1,240p' "$output_file" >&2
    return 1
  fi
}

run_release success true false true
printf '%s\n' \
  metrics:arn \
  'service:arn:aws:ecs:test:task-definition/mention-test:2:desired=1' \
  smoke \
  reconcile \
  >"$test_directory/success/expected.log"
diff -u \
  "$test_directory/success/expected.log" \
  "$test_directory/success/aws.log"

# A hyphen in the parameter path is its own case because it is its own bug: the
# bracket expression validating this name once matched every character EXCEPT a
# hyphen, so /oxy/mention/... deployed and /oxy/oxy-api/... did not. Mention's
# own path has no hyphen, which is why nothing here caught it. Keep both.
DEPLOY_TEST_METRICS_PARAMETER=/oxy/mention-mcp/INTERNAL_METRICS_TOKEN
run_release hyphenated-metrics-parameter true false true
DEPLOY_TEST_METRICS_PARAMETER=/oxy/mention/INTERNAL_METRICS_TOKEN
printf '%s\n' \
  metrics:arn \
  'service:arn:aws:ecs:test:task-definition/mention-test:2:desired=1' \
  smoke \
  reconcile \
  >"$test_directory/hyphenated-metrics-parameter/expected.log"
diff -u \
  "$test_directory/hyphenated-metrics-parameter/expected.log" \
  "$test_directory/hyphenated-metrics-parameter/aws.log"

run_release explicit-task-secret true false false 0 true
printf '%s\n' \
  task-secret:arn \
  'service:arn:aws:ecs:test:task-definition/mention-test:2:desired=1' \
  smoke \
  reconcile \
  >"$test_directory/explicit-task-secret/expected.log"
diff -u \
  "$test_directory/explicit-task-secret/expected.log" \
  "$test_directory/explicit-task-secret/aws.log"

run_release reconciliation-failure false false false 1
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/mention-test:2:desired=1' \
  smoke \
  reconcile \
  tasklogs \
  'service:arn:aws:ecs:test:task-definition/mention-test:1:desired=1' \
  >"$test_directory/reconciliation-failure/expected.log"
diff -u \
  "$test_directory/reconciliation-failure/expected.log" \
  "$test_directory/reconciliation-failure/aws.log"

run_release migration-failure false true false 1
printf '%s\n' \
  reconcile \
  tasklogs \
  >"$test_directory/migration-failure/expected.log"
diff -u \
  "$test_directory/migration-failure/expected.log" \
  "$test_directory/migration-failure/aws.log"
grep -F \
  "[migration] fixture failure" \
  "$test_directory/migration-failure/output.log" \
  >/dev/null
if grep -q '^service:' "$test_directory/migration-failure/aws.log"; then
  echo "Failed migration reached update-service." >&2
  exit 1
fi

run_release zero-desired-count false false false 0 false 0
grep -F \
  "must have a positive desiredCount before deployment (current: 0)" \
  "$test_directory/zero-desired-count/output.log" \
  >/dev/null
if [[ -s "$test_directory/zero-desired-count/aws.log" ]]; then
  echo "Zero-capacity service reached a mutating AWS call." >&2
  exit 1
fi

run_release transient-zero-deployment true false false 0 false 1 transient-zero-deployment
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/mention-test:2:desired=1' \
  smoke \
  reconcile \
  >"$test_directory/transient-zero-deployment/expected.log"
diff -u \
  "$test_directory/transient-zero-deployment/expected.log" \
  "$test_directory/transient-zero-deployment/aws.log"
grep -F \
  "has not assigned desired tasks" \
  "$test_directory/transient-zero-deployment/output.log" \
  >/dev/null

run_release zero-service-during-deploy false false false 0 false 1 zero-service-during-deploy
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/mention-test:2:desired=1' \
  'service:arn:aws:ecs:test:task-definition/mention-test:1:desired=1' \
  >"$test_directory/zero-service-during-deploy/expected.log"
diff -u \
  "$test_directory/zero-service-during-deploy/expected.log" \
  "$test_directory/zero-service-during-deploy/aws.log"
grep -F \
  "service mention-test reached desiredCount=0 during the deployment rollout" \
  "$test_directory/zero-service-during-deploy/output.log" \
  >/dev/null

run_release completed-zero-deployment false false false 0 false 1 completed-zero-deployment
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/mention-test:2:desired=1' \
  'service:arn:aws:ecs:test:task-definition/mention-test:1:desired=1' \
  >"$test_directory/completed-zero-deployment/expected.log"
diff -u \
  "$test_directory/completed-zero-deployment/expected.log" \
  "$test_directory/completed-zero-deployment/aws.log"
grep -F \
  "completed at desiredCount=0; refusing to accept a zero-task steady state" \
  "$test_directory/completed-zero-deployment/output.log" \
  >/dev/null

echo "Deployment script transaction tests passed."
