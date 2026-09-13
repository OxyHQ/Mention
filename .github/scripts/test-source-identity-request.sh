#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
export CLUSTER=oxy-cluster SERVICE=mention TEST_ROOT=$scratch TEST_CASE=success
export EXPECTED_IMAGE_DIGEST=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
export REQUEST_INSPECTION='{"requestId":"a5956d3d-c89f-4c8a-b8c5-5abce3ac7c10","sourceSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","startTime":"2026-09-13T08:05:50Z","endTime":"2026-09-13T08:06:20Z"}'
aws() {
  local command="$1 $2"
  echo "$command" >> "$TEST_ROOT/calls"
  case "$command" in
    'ecs describe-services') echo '{"failures":[],"services":[{"status":"ACTIVE","desiredCount":1,"runningCount":1,"pendingCount":0,"deployments":[{"rolloutState":"COMPLETED"}],"taskDefinition":"fixture:1"}]}' ;;
    'ecs describe-task-definition') jq -n --arg image "237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/mention@$EXPECTED_IMAGE_DIGEST" '{containerDefinitions:[{name:"backend",image:$image,logConfiguration:{options:{"awslogs-group":"group","awslogs-stream-prefix":"ecs"}}}]}' ;;
    'ecr batch-get-image') jq -n --arg digest "$(if [[ "$TEST_CASE" == wrong-image ]]; then echo sha256:wrong; else echo "$EXPECTED_IMAGE_DIGEST"; fi)" '{failures:[],images:[{imageId:{imageDigest:$digest}}]}' ;;
    'ecs list-tasks') echo '{"taskArns":["fixture/task/one"]}' ;;
    'ecs describe-tasks') jq -n --arg digest "$EXPECTED_IMAGE_DIGEST" '{failures:[],tasks:[{taskDefinitionArn:"fixture:1",lastStatus:"RUNNING",containers:[{name:"backend",imageDigest:$digest,lastStatus:"RUNNING"}]}]}' ;;
    'logs get-log-events')
      [[ "$*" == *'--start-time 1789286750000 --end-time 1789286780000'* ]]
      if [[ "$*" == *--next-token* ]]; then echo '{"events":[],"nextForwardToken":"done"}'; return; fi
      jq -n '{events:[{timestamp:1789286763891,message:({requestId:"a5956d3d-c89f-4c8a-b8c5-5abce3ac7c10",route:"/unmatched",oxyCallCount:0,failedOxyCallCount:0,queryCount:2,failedQueryCount:0,status:500,error:{name:"PostgresError",code:"23505",message:"PRIVATE_TOKEN",stack:"TypeError: PRIVATE_TOKEN\n at /app/packages/backend/dist/src/utils/error.js:45:1"}} | tojson)},{timestamp:1789286763892,message:({msg:"Unhandled error in request handler",error:"WRONGTYPE Operation against PRIVATE_TOKEN; value is not an integer",stack:"TypeError: PRIVATE_TOKEN\n at /app/packages/backend/dist/src/utils/error.js:45:1"} | tojson)},{timestamp:1789286763893,message:({requestId:"unrelated",error:"PRIVATE_TOKEN"} | tojson)}],nextForwardToken:"done"}' ;;
    *) echo "Unexpected operation $command" >&2; return 1 ;;
  esac
}
git() { printf 'packages/backend/src/utils/error.ts\npackages/backend/src/utils/unrelated.ts\n'; }
export -f aws git
selector=$REQUEST_INSPECTION
for TEST_CASE in success wrong-image wrong-selector wrong-window; do
  export TEST_CASE REQUEST_INSPECTION=$selector
  if [[ "$TEST_CASE" == wrong-selector ]]; then export REQUEST_INSPECTION='{"requestId":"arbitrary"}'; fi
  if [[ "$TEST_CASE" == wrong-window ]]; then export REQUEST_INSPECTION="${selector/08:05:50/08:00:50}"; fi
  mkdir "$scratch/$TEST_CASE"
  : > "$scratch/calls"
  status=0
  (cd "$scratch/$TEST_CASE" && bash "$root/.github/scripts/inspect-source-identity-request.sh") > "$scratch/$TEST_CASE/output" 2>&1 || status=$?
  if [[ "$TEST_CASE" == success ]]; then
    [[ "$status" == 0 ]] || { cat "$scratch/$TEST_CASE/output"; exit 1; }
    jq -e '.readOnly and (.matches | length == 2) and .matches[0].requestCorrelated and .matches[0].codes == ["23505"] and .matches[0].modules == ["src/utils/error.js"] and (.matches[1].requestCorrelated | not) and .matches[1].names == ["TypeError"] and .matches[0].route == "/unmatched" and .matches[0].counts == {oxyCallCount:0,failedOxyCallCount:0,queryCount:2,failedQueryCount:0} and .matches[1].category == "redis_operation" and .matches[1].redisFailures == ["WRONGTYPE","NONINTEGER"]' "$scratch/$TEST_CASE/reconciliation-request.json" >/dev/null
  else [[ "$status" != 0 ]] || { echo "Accepted $TEST_CASE"; exit 1; }; fi
  if [[ "$TEST_CASE" == wrong-selector || "$TEST_CASE" == wrong-window ]]; then
    [[ ! -s "$scratch/calls" ]] || { echo "Read AWS before refusing $TEST_CASE"; exit 1; }
  fi
  ! grep -R -q PRIVATE_TOKEN "$scratch/$TEST_CASE"
  ! grep -q 'run-task\|register-task-definition\|update-service\|stop-task' "$scratch/calls"
  echo "PASS request $TEST_CASE"
done
