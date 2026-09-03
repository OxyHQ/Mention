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
export DEPLOY_TEST_METRICS_PARAMETER=/oxy/sampleapp/INTERNAL_METRICS_TOKEN
export DEPLOY_TEST_TASK_EXIT_CODE=0
export DEPLOY_TEST_EXPECT_TASK_SECRET_ARN=false
export DEPLOY_TEST_EXPECT_TASK_ENV=false
export DEPLOY_TEST_EXPECT_SECRET_REMOVED=
export DEPLOY_TEST_SERVICE_DESIRED_COUNT=1
export DEPLOY_TEST_ROLLOUT_SCENARIO=healthy
# The `lastStatus` a mocked one-shot reports. `RUNNING` never resolves, which is
# how a case reaches the wait TIMEOUT rather than the exit-code path -- the only
# route to the EXIT trap's unfinished-task warning.
export DEPLOY_TEST_TASK_LAST_STATUS=STOPPED

aws() {
  local service_json='{
    "failures": [],
    "services": [{
      "status": "ACTIVE",
      "taskDefinition": "arn:aws:ecs:test:task-definition/deploy-test:1",
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
          "taskDefinition": "arn:aws:ecs:test:task-definition/deploy-test:2",
          "status": "PRIMARY",
          "rolloutState": "COMPLETED",
          "runningCount": 1,
          "desiredCount": 1
        },
        {
          "taskDefinition": "arn:aws:ecs:test:task-definition/deploy-test:1",
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
              if .taskDefinition == "arn:aws:ecs:test:task-definition/deploy-test:2"
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
              if .taskDefinition == "arn:aws:ecs:test:task-definition/deploy-test:2"
              then .desiredCount = 0 | .runningCount = 0
              else .
              end
            )
        ' <<<"$service_json")"
      elif [[ "$DEPLOY_TEST_ROLLOUT_SCENARIO" == "completed-zero-deployment" &&
              "$describe_count" == "2" ]]; then
        service_json="$(jq '
          .services[0].deployments |= map(
              if .taskDefinition == "arn:aws:ecs:test:task-definition/deploy-test:2"
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
        "family": "deploy-test",
        "networkMode": "awsvpc",
        "requiresCompatibilities": ["FARGATE"],
        "cpu": "256",
        "memory": "512",
        "containerDefinitions": [{
          "name": "deploy-test",
          "image": "example.invalid/deploy-test:old",
          "essential": true,
          "secrets": [
            {
              "name": "DOOMED_TASK_SECRET",
              "valueFrom": "arn:aws:ssm:test:123456789012:parameter/oxy/sample-app/DOOMED_TASK_SECRET"
            },
            {
              "name": "KEPT_TASK_SECRET",
              "valueFrom": "arn:aws:ssm:test:123456789012:parameter/oxy/sample-app/KEPT_TASK_SECRET"
            }
          ],
          "logConfiguration": {
            "logDriver": "awslogs",
            "options": {
              "awslogs-group": "/ecs/deploy-test",
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
          | select(.name == "deploy-test")
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
      if [[ "$DEPLOY_TEST_EXPECT_SECRET_REMOVED" != "" ]]; then
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
        # Two verdicts, not one. Asserting only the ABSENCE of the removed name
        # passes just as well against a render that dropped every secret, or
        # against a definition that never carried it -- so the surviving secret
        # is asserted in the same breath. Both are logged, so a wrong answer
        # names itself in the expected.log diff rather than vanishing into an
        # exit status.
        if jq -e --arg name "$DEPLOY_TEST_EXPECT_SECRET_REMOVED" '
          [.containerDefinitions[] | select(.name == "deploy-test") | .secrets[] | .name]
          | (index($name) | not) and (index("KEPT_TASK_SECRET") != null)
        ' "$input_json" >/dev/null; then
          printf 'secret-removed\n' >>"$DEPLOY_TEST_LOG"
        else
          printf 'secret-removed:MISMATCH\n' >>"$DEPLOY_TEST_LOG"
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
          | select(.name == "deploy-test")
          | .secrets[]
          | select(
              .name == "EXTRA_TASK_SECRET" and
              .valueFrom == "arn:aws:ssm:test:123456789012:parameter/oxy/sample-app/EXTRA_TASK_SECRET"
            )
        ' "$input_json" >/dev/null; then
          printf 'task-secret:arn\n' >>"$DEPLOY_TEST_LOG"
        else
          printf 'task-secret:arn:MISMATCH\n' >>"$DEPLOY_TEST_LOG"
        fi
      fi
      if [[ "$DEPLOY_TEST_EXPECT_TASK_ENV" == "true" ]]; then
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
        if jq -e '
          .containerDefinitions[]
          | select(.name == "deploy-test")
          | .environment[]
          | select(
              .name == "OXY_INFERENCE_ROUTING_PROFILE_ID" and
              .value == "01a06477-94f5-74f0-bc25-4c5c13b93ccd"
            )
        ' "$input_json" >/dev/null; then
          printf 'task-env:value\n' >>"$DEPLOY_TEST_LOG"
        else
          printf 'task-env:value:MISMATCH\n' >>"$DEPLOY_TEST_LOG"
        fi
      fi
      printf '%s\n' "arn:aws:ecs:test:task-definition/deploy-test:2"
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
      # Log the command this one-shot was actually given, not a fixed token. The
      # release runs several one-shots (each migration, then the reconciliation
      # task) through the SAME call, so a mock that logged a constant could not
      # tell them apart -- it recorded a migration task as "reconcile" and was
      # blind to their order, which is the one property worth asserting here.
      local overrides="" take_next=false argument
      for argument in "$@"; do
        if [[ "$take_next" == "true" ]]; then
          overrides="$argument"
          take_next=false
          continue
        fi
        if [[ "$argument" == "--overrides" ]]; then
          take_next=true
        fi
      done
      if [[ -z "$overrides" ]]; then
        echo "Mocked run-task received no --overrides." >&2
        return 1
      fi
      printf 'task:%s\n' \
        "$(jq -r '.containerOverrides[0].command | join(" ")' <<<"$overrides")" \
        >>"$DEPLOY_TEST_LOG"
      printf '%s\n' '{
        "failures": [],
        "tasks": [{"taskArn": "arn:aws:ecs:test:task/deploy-test-one-shot"}]
      }'
      ;;
    "ecs describe-tasks")
      printf '{
        "failures": [],
        "tasks": [{
          "lastStatus": "%s",
          "stoppedReason": "Essential container exited",
          "containers": [{
            "name": "deploy-test",
            "exitCode": %s
          }]
        }]
      }\n' "$DEPLOY_TEST_TASK_LAST_STATUS" "$DEPLOY_TEST_TASK_EXIT_CODE"
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
  local smoke_exit_code="${9:-0}"
  local inject_task_env="${10:-false}"
  local case_directory="$test_directory/$case_name"
  local output_file="$case_directory/output.log"
  local smoke_script="$case_directory/smoke.sh"

  mkdir -p "$case_directory"
  DEPLOY_TEST_LOG="$case_directory/aws.log"
  DEPLOY_TEST_EXPECT_METRICS_ARN="$inject_internal_metrics"
  DEPLOY_TEST_TASK_EXIT_CODE="$task_exit_code"
  DEPLOY_TEST_EXPECT_TASK_SECRET_ARN="$inject_task_secret"
  DEPLOY_TEST_EXPECT_TASK_ENV="$inject_task_env"
  DEPLOY_TEST_SERVICE_DESIRED_COUNT="$service_desired_count"
  DEPLOY_TEST_ROLLOUT_SCENARIO="$rollout_scenario"
  export DEPLOY_TEST_LOG DEPLOY_TEST_EXPECT_METRICS_ARN
  export DEPLOY_TEST_TASK_EXIT_CODE
  export DEPLOY_TEST_EXPECT_TASK_SECRET_ARN
  export DEPLOY_TEST_EXPECT_TASK_ENV
  export DEPLOY_TEST_SERVICE_DESIRED_COUNT
  export DEPLOY_TEST_ROLLOUT_SCENARIO

  # The generated smoke fixture expands DEPLOY_TEST_LOG when it runs; its exit
  # code is the entire interface deploy-ecs-image.sh reads, so each case picks
  # one. 75 is the "failed, but a rollback cannot repair it" code.
  # shellcheck disable=SC2016
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "smoke\n" >>"$DEPLOY_TEST_LOG"' \
    "exit $smoke_exit_code" \
    >"$smoke_script"

  local -a release_environment=(
    AWS_REGION=test
    AWS_ACCOUNT_ID=123456789012
    CLUSTER=deploy-test
    APP=deploy-test
    CONTAINER_NAME=deploy-test
    ALLOW_ZERO_DESIRED_COUNT="${DEPLOY_TEST_ALLOW_ZERO_DESIRED_COUNT:-}"
    IMAGE_URI="example.invalid/deploy-test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
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
      TASK_SECRET_OVERRIDES_JSON='{"EXTRA_TASK_SECRET":"arn:aws:ssm:test:123456789012:parameter/oxy/sample-app/EXTRA_TASK_SECRET"}'
    )
  fi
  if [[ "$inject_task_env" == "true" ]]; then
    release_environment+=(
      TASK_ENV_OVERRIDES_JSON='{"OXY_INFERENCE_ROUTING_PROFILE_ID":"01a06477-94f5-74f0-bc25-4c5c13b93ccd"}'
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
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  task:reconcile \
  >"$test_directory/success/expected.log"
diff -u \
  "$test_directory/success/expected.log" \
  "$test_directory/success/aws.log"

# A hyphen in the parameter path is its own case because it is its own bug: the
# bracket expression validating this name once matched every character EXCEPT a
# hyphen, so an app whose path had none deployed and an app whose path had one
# did not -- and the only repo with a smoke fixture at the time was one of the
# former, which is why nothing here caught it.
#
# KEEP BOTH, and keep the plain one's app segment hyphen-FREE. That asymmetry is
# the entire test: rename them to two spellings that both contain a hyphen and
# this pair silently stops discriminating, while the suite still passes and still
# goes red under a mutation -- just for the wrong case.
DEPLOY_TEST_METRICS_PARAMETER=/oxy/sample-app/INTERNAL_METRICS_TOKEN
run_release hyphenated-metrics-parameter true false true
DEPLOY_TEST_METRICS_PARAMETER=/oxy/sampleapp/INTERNAL_METRICS_TOKEN
printf '%s\n' \
  metrics:arn \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  task:reconcile \
  >"$test_directory/hyphenated-metrics-parameter/expected.log"
diff -u \
  "$test_directory/hyphenated-metrics-parameter/expected.log" \
  "$test_directory/hyphenated-metrics-parameter/aws.log"

run_release explicit-task-secret true false false 0 true
printf '%s\n' \
  task-secret:arn \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  task:reconcile \
  >"$test_directory/explicit-task-secret/expected.log"
diff -u \
  "$test_directory/explicit-task-secret/expected.log" \
  "$test_directory/explicit-task-secret/aws.log"

run_release explicit-task-env true false false 0 false 1 healthy 0 true
printf '%s\n' \
  task-env:value \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  task:reconcile \
  >"$test_directory/explicit-task-env/expected.log"
diff -u \
  "$test_directory/explicit-task-env/expected.log" \
  "$test_directory/explicit-task-env/aws.log"

run_release reconciliation-failure false false false 1
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  task:reconcile \
  tasklogs \
  'service:arn:aws:ecs:test:task-definition/deploy-test:1:desired=1' \
  >"$test_directory/reconciliation-failure/expected.log"
diff -u \
  "$test_directory/reconciliation-failure/expected.log" \
  "$test_directory/reconciliation-failure/aws.log"

# A migration one-shot that exits non-zero stops the release, and nothing after
# it runs. The assertion names the FIRST task by its full command -- this case
# used to expect a bare "reconcile", because the mock could not tell a migration
# task from the reconciliation task and so recorded the wrong one by name.
run_release migration-failure false true false 1
printf '%s\n' \
  'task:bun packages/backend/dist/src/db/migrate.js --target-database=mention' \
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
if grep -qF 'assertPostgresPopulated.js' \
  "$test_directory/migration-failure/aws.log"; then
  echo "A failed migration still ran the step after it." >&2
  exit 1
fi

# Every pre-rollout one-shot on one release, and the ORDER is the assertion. The
# schema migration is first, because a task that boots without its schema becomes
# ready and then fails every query. The blocked-domain reconciliation is LAST
# because it is the only one that deletes rows, so it must not run before the
# schema is current and the store is known to be populated. A
# `diff` of the whole log is what notices a reordering -- grepping for the
# entries would pass in any order.
run_release migration-order true true false 0
printf '%s\n' \
  'task:bun packages/backend/dist/src/db/migrate.js --target-database=mention' \
  'task:bun packages/backend/dist/src/scripts/assertPostgresPopulated.js' \
  'task:bun packages/backend/dist/src/scripts/reconcileBlockedDomains.js' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  task:reconcile \
  >"$test_directory/migration-order/expected.log"
diff -u \
  "$test_directory/migration-order/expected.log" \
  "$test_directory/migration-order/aws.log"

# THE POPULATION FLOOR IS LAST, AND THAT IS THE ASSERTION ABOVE, not a detail
# of the diff: it counts rows, so it cannot run before the Postgres migration
# has created the tables to count. The whole-log `diff` is what notices if
# someone reorders the list; grepping for the entry would pass either way round.
#
# What it buys is the case no HTTP check can see. A trunk image went live
# against an EMPTY Postgres on 2026-08-04 and every smoke check passed, because
# an empty store answers the anonymous feed 200 with no items. This entry fails
# BEFORE `update-service`, so nothing is routed -- which the sequence above
# proves by position: `service:` comes after it.

# A migration one-shot that never STOPS is the case that reaches the EXIT trap's
# unfinished-task warning -- the only signal that a migration may still be
# mutating the database after the deploy gave up, and unrecoverable because the
# deploy role cannot call ecs:StopTask.
#
# This case exists to protect the migration loop's PROCESS SUBSTITUTION. Piping
# into the loop instead puts its body in a subshell, so run_one_shot_command's
# active_one_shot_* writes never reach the parent and the trap reads their
# initial values -- the warning silently stops being emitted. `set -e` catches
# the failing pipeline either way, so nothing else here can tell the two forms
# apart: the release stops before update-service under both, and every other
# assertion in this file passes under both. Measured, not reasoned.
DEPLOY_TEST_TASK_LAST_STATUS=RUNNING
run_release migration-task-never-stops false true false 0
DEPLOY_TEST_TASK_LAST_STATUS=STOPPED
printf '%s\n' \
  'task:bun packages/backend/dist/src/db/migrate.js --target-database=mention' \
  >"$test_directory/migration-task-never-stops/expected.log"
diff -u \
  "$test_directory/migration-task-never-stops/expected.log" \
  "$test_directory/migration-task-never-stops/aws.log"
if ! grep -qF \
  "Unfinished Postgres migration task arn:aws:ecs:test:task/deploy-test-one-shot may still be running" \
  "$test_directory/migration-task-never-stops/output.log"; then
  # Named rather than left as a bare `exit 1`, because the most likely way to
  # arrive here is having rewritten the migration loop as a pipe -- and every
  # other assertion in this file passes in that state, so an unexplained failure
  # points at nothing.
  echo "A migration task left running produced no unfinished-task warning." >&2
  echo "If the migration loop was changed to a pipe, its body runs in a subshell" >&2
  echo "and the EXIT trap never sees active_one_shot_*. Use process substitution." >&2
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
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  task:reconcile \
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
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:1:desired=1' \
  >"$test_directory/zero-service-during-deploy/expected.log"
diff -u \
  "$test_directory/zero-service-during-deploy/expected.log" \
  "$test_directory/zero-service-during-deploy/aws.log"
grep -F \
  "service deploy-test reached desiredCount=0 during the deployment rollout" \
  "$test_directory/zero-service-during-deploy/output.log" \
  >/dev/null

run_release completed-zero-deployment false false false 0 false 1 completed-zero-deployment
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:1:desired=1' \
  >"$test_directory/completed-zero-deployment/expected.log"
diff -u \
  "$test_directory/completed-zero-deployment/expected.log" \
  "$test_directory/completed-zero-deployment/aws.log"
grep -F \
  "completed at desiredCount=0; refusing to accept a zero-task steady state" \
  "$test_directory/completed-zero-deployment/output.log" \
  >/dev/null

# A smoke failure the smoke script attributes to the new image rolls the service
# back, and stops the release before the reconciliation task runs.
run_release smoke-hermetic-failure false false false 0 false 1 healthy 1
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  'service:arn:aws:ecs:test:task-definition/deploy-test:1:desired=1' \
  >"$test_directory/smoke-hermetic-failure/expected.log"
diff -u \
  "$test_directory/smoke-hermetic-failure/expected.log" \
  "$test_directory/smoke-hermetic-failure/aws.log"
grep -F \
  "Post-deploy smoke checks failed." \
  "$test_directory/smoke-hermetic-failure/output.log" \
  >/dev/null

# A smoke failure the smoke script attributes to something outside the new image
# (exit 75) must NOT roll back: the service stays on the new task definition, the
# release finishes its reconciliation task, and the job still fails so the
# failure is paged rather than swallowed.
run_release smoke-no-rollback-failure false false false 0 false 1 healthy 75
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  task:reconcile \
  >"$test_directory/smoke-no-rollback-failure/expected.log"
diff -u \
  "$test_directory/smoke-no-rollback-failure/expected.log" \
  "$test_directory/smoke-no-rollback-failure/aws.log"
if grep -qF \
  'service:arn:aws:ecs:test:task-definition/deploy-test:1:' \
  "$test_directory/smoke-no-rollback-failure/aws.log"; then
  echo "A smoke failure that cannot be repaired by a rollback rolled back anyway." >&2
  exit 1
fi
grep -F \
  "stays on arn:aws:ecs:test:task-definition/deploy-test:2" \
  "$test_directory/smoke-no-rollback-failure/output.log" \
  >/dev/null
grep -F \
  "Nothing was rolled back; this release needs a human." \
  "$test_directory/smoke-no-rollback-failure/output.log" \
  >/dev/null

# ALLOW_ZERO_DESIRED_COUNT, in the four states that matter.
#
# A planned window may deploy a service while it is deliberately scaled to zero
# -- the Postgres cutover was the case this was written for, where bringing the
# old image up after the copy would have let real writes land in the store being
# abandoned. Every OTHER deploy must still refuse a zero-count service, and the
# exemption must not outlive the window.
#
# The value is `<service>:<YYYY-MM-DD>`. Two cases carry the design:
#   - WRONG SERVICE proves the value is compared against APP rather than read as
#     a boolean. A boolean passes every other case here.
#   - EXPIRED proves a forgotten variable disarms itself. Without it the
#     exemption is a permanent reduction in protection bought for one window.

zero_optin_future="$(date -u -d '+2 days' +%F)"
zero_optin_past="$(date -u -d '-1 day' +%F)"

# 1. Absent -> refuses.
DEPLOY_TEST_ALLOW_ZERO_DESIRED_COUNT="" \
  run_release zero-count-optin-absent false false false 0 false 0
grep -F "must have a positive desiredCount before deployment (current: 0)" \
  "$test_directory/zero-count-optin-absent/output.log" >/dev/null
if [[ -s "$test_directory/zero-count-optin-absent/aws.log" ]]; then
  echo "Zero-count deploy with no opt-in reached a mutating AWS call." >&2
  exit 1
fi

# 2. WRONG service, valid date -> refuses. A boolean cannot tell this from case 4.
DEPLOY_TEST_ALLOW_ZERO_DESIRED_COUNT="some-other-service:$zero_optin_future" \
  run_release zero-count-optin-wrong-service false false false 0 false 0
grep -F "must have a positive desiredCount before deployment (current: 0)" \
  "$test_directory/zero-count-optin-wrong-service/output.log" >/dev/null
if [[ -s "$test_directory/zero-count-optin-wrong-service/aws.log" ]]; then
  echo "Zero-count deploy authorised by the WRONG service name reached a mutating AWS call." >&2
  echo "The opt-in is being read as a boolean rather than compared against APP." >&2
  exit 1
fi

# 3. Right service, EXPIRED -> refuses, and says so by name rather than falling
#    through to the generic desiredCount message.
DEPLOY_TEST_ALLOW_ZERO_DESIRED_COUNT="deploy-test:$zero_optin_past" \
  run_release zero-count-optin-expired false false false 0 false 0
grep -F "ALLOW_ZERO_DESIRED_COUNT expired on $zero_optin_past" \
  "$test_directory/zero-count-optin-expired/output.log" >/dev/null
if [[ -s "$test_directory/zero-count-optin-expired/aws.log" ]]; then
  echo "An EXPIRED zero-count opt-in reached a mutating AWS call." >&2
  exit 1
fi

# 3b. A regex-valid but nonexistent date must refuse rather than sort after every
#     real date and never expire — the one fail-OPEN this could have had.
DEPLOY_TEST_ALLOW_ZERO_DESIRED_COUNT="deploy-test:2026-13-45" \
  run_release zero-count-optin-impossible-date false false false 0 false 0
grep -F "carries an invalid date: 2026-13-45" \
  "$test_directory/zero-count-optin-impossible-date/output.log" >/dev/null

# 4. Right service, valid date -> proceeds, and SAYS so.
DEPLOY_TEST_ALLOW_ZERO_DESIRED_COUNT="deploy-test:$zero_optin_future" \
  run_release zero-count-optin-correct true false false 0 false 0 completed-zero-deployment
grep -F "authorised by ALLOW_ZERO_DESIRED_COUNT=deploy-test:$zero_optin_future (expires $zero_optin_future)" \
  "$test_directory/zero-count-optin-correct/output.log" >/dev/null
grep -F "completed at desiredCount=0, as authorised" \
  "$test_directory/zero-count-optin-correct/output.log" >/dev/null
if grep -qF "refusing to accept a zero-task steady state" \
  "$test_directory/zero-count-optin-correct/output.log"; then
  echo "An authorised zero-count deploy was still killed by the steady-state guard." >&2
  echo "The exemption was applied to the pre-check only; both zero-checks need it." >&2
  exit 1
fi

# A secret NAMED in TASK_SECRET_REMOVALS must leave the registered definition,
# and the one beside it must stay. The live definition the script derives from
# carries both, so this cannot pass by removing a secret that was never there --
# the mirror assertion on KEPT_TASK_SECRET is what rules out a render that simply
# dropped them all.
DEPLOY_TEST_EXPECT_SECRET_REMOVED=DOOMED_TASK_SECRET \
  TASK_SECRET_REMOVALS=DOOMED_TASK_SECRET \
  run_release secret-removal true false false 0
grep -qx 'secret-removed' "$test_directory/secret-removal/aws.log" || {
  echo "TASK_SECRET_REMOVALS did not remove the secret from the registered definition." >&2
  grep -n 'secret-removed' "$test_directory/secret-removal/aws.log" >&2 || true
  exit 1
}

# A name in BOTH lists is refused rather than resolved: the render filters by
# name and then concatenates the overrides, so the outcome would depend on the
# order of two operations nobody reads.
TASK_SECRET_REMOVALS=EXTRA_TASK_SECRET \
  TASK_SECRET_OVERRIDES_JSON='{"EXTRA_TASK_SECRET":"arn:aws:ssm:test:123456789012:parameter/oxy/sample-app/EXTRA_TASK_SECRET"}' \
  run_release secret-conflict false false false 0
grep -q 'in both TASK_SECRET_OVERRIDES_JSON and TASK_SECRET_REMOVALS' \
  "$test_directory/secret-conflict/output.log" || {
  echo "The conflicting-name refusal must name BOTH lists, or it is indistinguishable from any other failure." >&2
  exit 1
}

echo "Deployment script transaction tests passed."
