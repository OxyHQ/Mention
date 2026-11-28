#!/usr/bin/env bash
# wait-one-shot-task.sh against a fake ECS and a fake clock: the deadlines are
# counted from the container's start, not from the launch.

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repository_root/.github/scripts/wait-one-shot-task.sh"
test_directory="$(mktemp -d)"
trap 'rm -rf -- "$test_directory"' EXIT

export FAKE_CLOCK_FILE="$test_directory/clock"
export FAKE_EPOCH=1792470000

# Seconds after launch at which the container starts and stops; empty = never.
export FAKE_START_AFTER=""
export FAKE_STOP_AFTER=""
export FAKE_COMMAND='["busybox","timeout","-s","TERM","-k","30","3300","bun","run.js"]'

aws() {
  local now since
  now=$(cat "$FAKE_CLOCK_FILE")
  since=$((now - FAKE_EPOCH))
  if [[ "$*" == *containerOverrides* ]]; then
    printf '%s\n' "$FAKE_COMMAND"
    return
  fi
  local started_at=None status=PROVISIONING
  if [[ -n "$FAKE_START_AFTER" ]] && ((since >= FAKE_START_AFTER)); then
    started_at=$(command date -u -d "@$((FAKE_EPOCH + FAKE_START_AFTER))" +%Y-%m-%dT%H:%M:%S.000000+00:00)
    status=RUNNING
  fi
  if [[ -n "$FAKE_STOP_AFTER" ]] && ((since >= FAKE_STOP_AFTER)); then
    status=STOPPED
  fi
  printf '%s\t%s\n' "$status" "$started_at"
}
date() {
  if [[ "$*" == "+%s" ]]; then
    cat "$FAKE_CLOCK_FILE"
  else
    command date "$@"
  fi
}
sleep() {
  echo $(($(cat "$FAKE_CLOCK_FILE") + $1)) >"$FAKE_CLOCK_FILE"
}
export -f aws date sleep

failures=0
expect() {
  local name=$1 want_status=$2 want_output=$3 output status
  echo "$FAKE_EPOCH" >"$FAKE_CLOCK_FILE"
  set +e
  output=$(bash "$script" cluster arn:aws:ecs:task/x 2>&1)
  status=$?
  set -e
  if [[ "$status" == "$want_status" && "$output" == *"$want_output"* ]]; then
    echo "  ok   $name"
  else
    echo "  FAIL $name (exit $status)"
    printf '%s\n' "$output" | tail -3 | sed 's/^/       /'
    failures=$((failures + 1))
  fi
}

# The 2026-10-20 apply: 12 minutes to start, then most of its 55-minute bound.
# A wait counted from launch (3600s) gave up on it.
FAKE_START_AFTER=720 FAKE_STOP_AFTER=4010 \
  expect 'a slow start does not eat into the container bound' 0 'task status=STOPPED'
FAKE_START_AFTER=30 FAKE_STOP_AFTER=60 \
  expect 'a quick task is waited for' 0 'task status=STOPPED'
FAKE_START_AFTER="" FAKE_STOP_AFTER="" \
  expect 'a task that never starts fails after the provisioning bound' 1 'did not start within 1200s'
FAKE_START_AFTER=60 FAKE_STOP_AFTER="" \
  expect 'a container that outlives its own bound fails' 1 'outlived its own 3300s bound'
FAKE_COMMAND='["busybox","timeout","-s","TERM","-k","30","900","bun","run.js"]' \
  FAKE_START_AFTER=60 FAKE_STOP_AFTER="" \
  expect 'the bound is read from the task, not assumed' 1 'outlived its own 900s bound'
FAKE_COMMAND='["bun","run.js"]' FAKE_START_AFTER=0 FAKE_STOP_AFTER=10 \
  expect 'a container with no bound is refused' 1 'does not bound its container'

if ((failures > 0)); then
  echo "$failures case(s) failed."
  exit 1
fi
echo "All wait-one-shot-task cases passed."
