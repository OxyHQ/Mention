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
export DEPLOY_TEST_TASK_EXIT_CODE=0
export DEPLOY_TEST_EXPECT_TASK_SECRET_ARN=false

aws() {
  local service_json='{
    "failures": [],
    "services": [{
      "status": "ACTIVE",
      "taskDefinition": "arn:aws:ecs:test:task-definition/mention-test:1",
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

  case "$1 $2" in
    "ecs describe-services")
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
        jq -e '
          .containerDefinitions[]
          | select(.name == "mention-test")
          | .secrets[]
          | select(
              .name == "INTERNAL_METRICS_TOKEN" and
              .valueFrom == "arn:aws:ssm:test:123456789012:parameter/oxy/mention/INTERNAL_METRICS_TOKEN"
            )
        ' "$input_json" >/dev/null
        printf 'metrics:arn\n' >>"$DEPLOY_TEST_LOG"
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
        jq -e '
          .containerDefinitions[]
          | select(.name == "mention-test")
          | .secrets[]
          | select(
              .name == "MENTION_MCP_JWT_SECRET" and
              .valueFrom == "arn:aws:ssm:test:123456789012:parameter/oxy/mention-mcp/MENTION_MCP_JWT_SECRET"
            )
        ' "$input_json" >/dev/null
        printf 'task-secret:arn\n' >>"$DEPLOY_TEST_LOG"
      fi
      printf '%s\n' "arn:aws:ecs:test:task-definition/mention-test:2"
      ;;
    "ecs update-service")
      local previous_argument=""
      local task_definition=""
      local argument
      for argument in "$@"; do
        if [[ "$previous_argument" == "--task-definition" ]]; then
          task_definition="$argument"
          break
        fi
        previous_argument="$argument"
      done
      printf 'service:%s\n' "$task_definition" >>"$DEPLOY_TEST_LOG"
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
  local case_directory="$test_directory/$case_name"
  local output_file="$case_directory/output.log"
  local smoke_script="$case_directory/smoke.sh"

  mkdir -p "$case_directory"
  DEPLOY_TEST_LOG="$case_directory/aws.log"
  DEPLOY_TEST_EXPECT_METRICS_ARN="$inject_internal_metrics"
  DEPLOY_TEST_TASK_EXIT_CODE="$task_exit_code"
  DEPLOY_TEST_EXPECT_TASK_SECRET_ARN="$inject_task_secret"
  export DEPLOY_TEST_LOG DEPLOY_TEST_EXPECT_METRICS_ARN
  export DEPLOY_TEST_TASK_EXIT_CODE
  export DEPLOY_TEST_EXPECT_TASK_SECRET_ARN

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
      INTERNAL_METRICS_PARAMETER=/oxy/mention/INTERNAL_METRICS_TOKEN
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
  'service:arn:aws:ecs:test:task-definition/mention-test:2' \
  smoke \
  reconcile \
  >"$test_directory/success/expected.log"
diff -u \
  "$test_directory/success/expected.log" \
  "$test_directory/success/aws.log"

run_release explicit-task-secret true false false 0 true
printf '%s\n' \
  task-secret:arn \
  'service:arn:aws:ecs:test:task-definition/mention-test:2' \
  smoke \
  reconcile \
  >"$test_directory/explicit-task-secret/expected.log"
diff -u \
  "$test_directory/explicit-task-secret/expected.log" \
  "$test_directory/explicit-task-secret/aws.log"

run_release reconciliation-failure false false false 1
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/mention-test:2' \
  smoke \
  reconcile \
  tasklogs \
  'service:arn:aws:ecs:test:task-definition/mention-test:1' \
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

echo "Deployment script transaction tests passed."
