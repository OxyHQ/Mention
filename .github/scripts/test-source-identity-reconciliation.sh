#!/usr/bin/env bash
set -euo pipefail
repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_directory=$(mktemp -d)
trap 'rm -rf -- "$test_directory"' EXIT
export DEPLOY_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export EXPECTED_IMAGE_DIGEST=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
export CLUSTER=fixture-cluster SERVICE=fixture-service
export TEST_ROOT="$test_directory"
export TEST_CASE=success
export DRY_RUN=true
export CONFIRM_WRITE=''
export GITHUB_STEP_SUMMARY="$test_directory/summary"
git() {
  if [[ "$1" == fetch ]]; then return 0; fi
  if [[ "$TEST_CASE" == stale-source ]]; then echo cccccccccccccccccccccccccccccccccccccccc; else echo "$DEPLOY_SHA"; fi
}
aws() {
  local command="$1 $2"; shift 2
  echo "$command" >> "$TEST_ROOT/calls"
  case "$command" in
    'ecs describe-services')
      if [[ "$*" == *'--query'* ]]; then echo fixture-task:1; return; fi
      jq -n --arg state "$(if [[ "$TEST_CASE" == rolling ]]; then echo IN_PROGRESS; else echo COMPLETED; fi)" '{failures:[],services:[{status:"ACTIVE",desiredCount:1,runningCount:1,pendingCount:0,taskDefinition:"fixture-task:1",deployments:[{rolloutState:$state}],networkConfiguration:{awsvpcConfiguration:{subnets:["subnet-source"],securityGroups:["sg-source"],assignPublicIp:"ENABLED"}}}]}' ;;
    'ecs describe-task-definition')
      jq -n --arg image "237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/mention@$EXPECTED_IMAGE_DIGEST" '{taskRoleArn:"preserved-runtime-role",executionRoleArn:"preserved-execution-role",containerDefinitions:[{name:"backend",image:$image,secrets:[{name:"DATABASE_URL",valueFrom:"secret-reference"}],logConfiguration:{options:{"awslogs-group":"fixture-group","awslogs-stream-prefix":"ecs"}}}]}' ;;
    'ecr batch-get-image')
      local digest="$EXPECTED_IMAGE_DIGEST"
      if [[ "$TEST_CASE" == wrong-image ]]; then digest=sha256:wrong; fi
      jq -n --arg digest "$digest" '{failures:[],images:[{imageId:{imageDigest:$digest}}]}' ;;
    'ecs run-task')
      local overrides='' network='' taskdef=''
      while [[ $# -gt 0 ]]; do
        case "$1" in --overrides) overrides="${2#file://}";; --network-configuration) network="${2#file://}";; --task-definition) taskdef="$2";; esac
        shift
      done
      [[ "$taskdef" == fixture-task:1 ]]
      jq -e '.awsvpcConfiguration.subnets == ["subnet-source"] and .awsvpcConfiguration.securityGroups == ["sg-source"] and .awsvpcConfiguration.assignPublicIp == "ENABLED"' "$network" >/dev/null
      jq -e --arg dry "$DRY_RUN" '.containerOverrides[0] | .command == ["busybox","timeout","-s","TERM","-k","30","3300","bun","packages/backend/dist/src/scripts/reconcileMetaIdentityAndCrossposts.js"] and .environment[0] == {name:"DRY_RUN",value:$dry} and .environment[1].value == (if $dry == "false" then "reconcileMetaIdentityAndCrossposts" else "" end)' "$overrides" >/dev/null
      echo '{"failures":[],"tasks":[{"taskArn":"arn:fixture/task/one"}]}' ;;
    'ecs describe-tasks')
      jq -n --argjson code "$(if [[ "$TEST_CASE" == task-failure ]]; then echo 1; else echo 0; fi)" '{tasks:[{lastStatus:"STOPPED",containers:[{name:"backend",exitCode:$code}]}]}' ;;
    'logs get-log-events')
      if [[ "$TEST_CASE" == missing-report ]]; then echo '{"events":[],"nextForwardToken":"done"}'; return; fi
      if [[ "$*" == *'--next-token done'* ]]; then echo '{"events":[],"nextForwardToken":"done"}'; return; fi
      # The first page has no tally: pagination is required to find it.
      if [[ "$*" != *'--next-token'* ]]; then echo '{"events":[{"message":"not json"}],"nextForwardToken":"next"}'; return; fi
      jq -n --argjson dry "$DRY_RUN" '{events:[{message:({msg:"[reconcileMetaIdentityAndCrossposts] complete",dryRun:$dry,actorsExamined:2,actorsChanged:1,postsChanged:3,authorshipConflicts:0,mutesPreserved:1,clustersDissolved:1,postsExamined:5,postClustersCreated:0,refused:{oxy_identity_not_resolved:1}} | tojson)}],nextForwardToken:"done"}' ;;
    *) echo "Unexpected AWS operation $command" >&2; return 1 ;;
  esac
}
export -f git aws
run_case() {
  local name="$1" expected="$2"
  export TEST_CASE="$name"
  local case_dir="$test_directory/$name"
  mkdir -p "$case_dir/reviewed-preview"
  if [[ "$name" == apply || "$name" == wrong-preview ]]; then
    cp "$test_directory/success/reconciliation-report.json" "$case_dir/reviewed-preview/"
  fi
  if [[ "$name" == wrong-preview ]]; then
    sed -i "s/$DEPLOY_SHA/cccccccccccccccccccccccccccccccccccccccc/" "$case_dir/reviewed-preview/reconciliation-report.json"
  fi
  : > "$test_directory/calls"
  local status=0
  (cd "$case_dir" && bash "$repository_root/.github/scripts/run-source-identity-reconciliation.sh") > "$case_dir/output" 2>&1 || status=$?
  if [[ "$expected" == pass ]]; then
    [[ "$status" == 0 ]] || { cat "$case_dir/output"; exit 1; }
    jq -e '.report.postsChanged == 3 and .report.refused.oxy_identity_not_resolved == 1' "$case_dir/reconciliation-report.json" >/dev/null
  else
    [[ "$status" != 0 ]] || { echo "Expected refusal: $name"; exit 1; }
    if [[ "$name" != missing-report && "$name" != task-failure ]]; then
      ! grep -q '^ecs run-task$' "$test_directory/calls" || { echo "Started a task before refusing $name"; exit 1; }
    fi
  fi
  echo "PASS $name"
}
run_case success pass
run_case wrong-image fail
run_case stale-source fail
run_case rolling fail
run_case missing-report fail
run_case task-failure fail
export DRY_RUN=garbled
run_case invalid-mode fail
export DRY_RUN=false
run_case unconfirmed-write fail
export CONFIRM_WRITE=reconcileMetaIdentityAndCrossposts
run_case missing-preview fail
run_case wrong-preview fail
run_case apply pass
