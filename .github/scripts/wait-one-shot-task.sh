#!/usr/bin/env bash
# Wait for an ECS one-shot task to stop: `wait-one-shot-task.sh <cluster> <task-arn>`.
# Exits 0 once the task is STOPPED (the caller reads its exit code), 1 when it
# did not stop in time.
#
# Every `run-*.yml` one-shot bounds its container with busybox `timeout`, and
# that clock starts when the CONTAINER starts — after placement and the image
# pull. A wait counted from `run-task` gave up on a container still inside its
# own window whenever provisioning was slow: the file-reference apply of
# 2026-10-20 finished cleanly six minutes after its workflow reported failure.
# So there are two deadlines:
#   - PROVISION_MAX_SECS from launch for the container to start;
#   - the container's own bound + STOP_GRACE_SECS from ITS `startedAt`.
# The bound is read from the task's command override (`busybox timeout ... N`),
# so it cannot drift from the number the workflow passes. Every caller's
# `timeout-minutes` covers PROVISION_MAX_SECS + its bound + STOP_GRACE_SECS.

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <cluster> <task-arn>" >&2
  exit 2
fi
cluster=$1
task_arn=$2

readonly PROVISION_MAX_SECS=1200
readonly STOP_GRACE_SECS=150
readonly POLL_INTERVAL=15

run_secs=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" \
  --query 'tasks[0].overrides.containerOverrides[0].command' --output json |
  jq -r 'if type != "array" then empty
         else (index("timeout") // null) as $i
           | if $i == null then empty
             else .[$i + 1:] | until(length == 0 or (.[0] | startswith("-") | not); .[2:]) | .[0] // empty
             end
         end')
if ! [[ "$run_secs" =~ ^[0-9]+$ ]]; then
  echo "::error::Task $task_arn does not bound its container with \`busybox timeout <secs>\`; refusing to wait without a deadline."
  exit 1
fi

launched=$(date +%s)
deadline=$((launched + PROVISION_MAX_SECS))
started=""
while (($(date +%s) < deadline)); do
  read -r last_status started_at < <(aws ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" \
    --query 'tasks[0].[lastStatus,startedAt]' --output text)
  echo "($(($(date +%s) - launched)) s) task status=$last_status"
  if [[ "$last_status" == "STOPPED" ]]; then
    exit 0
  fi
  if [[ -z "$started" && -n "$started_at" && "$started_at" != "None" ]]; then
    started=$(date -d "$started_at" +%s)
    deadline=$((started + run_secs + STOP_GRACE_SECS))
    echo "container started; its ${run_secs}s bound ends by $(date -u -d "@$deadline" +%H:%M:%SZ)"
  fi
  sleep "$POLL_INTERVAL"
done

if [[ -z "$started" ]]; then
  echo "::error::Task $task_arn did not start within ${PROVISION_MAX_SECS}s. The deploy role cannot call ecs:StopTask; it may still be pending and must be checked in ECS."
else
  echo "::error::Task $task_arn outlived its own ${run_secs}s bound by more than ${STOP_GRACE_SECS}s. The deploy role cannot call ecs:StopTask; it may still be running and must be checked in ECS."
fi
exit 1
