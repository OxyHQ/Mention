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
export DRY_RUN=true OPERATION=reconcile
export ACTOR_URI=https://cache.example/users/fresh CANONICAL_ACCT=fresh@instagram.com TRANSPORT_ACCT=fresh@cache.example
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
      if [[ "$OPERATION" == inspect_cache ]]; then
        jq -e --arg actor "$ACTOR_URI" --arg canonical "$CANONICAL_ACCT" --arg transport "$TRANSPORT_ACCT" '.containerOverrides[0] | .command == ["sh","-c","busybox timeout -s TERM -k 30 3300 bun \"$1\"; status=$?; exit \"$status\"","mention-source-identity","packages/backend/dist/src/scripts/inspectFederatedIdentityCache.js"] and .environment == [{name:"DRY_RUN",value:"true"},{name:"CONFIRM_ADMIN_MUTATION",value:""},{name:"INSPECT_ACTOR_URI",value:$actor},{name:"INSPECT_CANONICAL_ACCT",value:$canonical},{name:"INSPECT_TRANSPORT_ACCT",value:$transport}]' "$overrides" >/dev/null
      else
      jq -e --arg dry "$DRY_RUN" '.containerOverrides[0] | .command == ["sh","-c","busybox timeout -s TERM -k 30 3300 bun \"$1\"; status=$?; exit \"$status\"","mention-source-identity","packages/backend/dist/src/scripts/reconcileMetaIdentityAndCrossposts.js"] and .environment[0] == {name:"DRY_RUN",value:$dry} and .environment[1].value == (if $dry == "false" then "reconcileMetaIdentityAndCrossposts" else "" end)' "$overrides" >/dev/null
      fi
      echo '{"failures":[],"tasks":[{"taskArn":"arn:fixture/task/one"}]}' ;;
    'ecs describe-tasks')
      jq -n --argjson code "$(if [[ "$TEST_CASE" == task-failure ]]; then echo 1; else echo 0; fi)" '{tasks:[{lastStatus:"STOPPED",containers:[{name:"backend",exitCode:$code}]}]}' ;;
    'logs get-log-events')
      if [[ "$TEST_CASE" == delayed-report && ! -f "$TEST_ROOT/delayed-once" ]]; then
        touch "$TEST_ROOT/delayed-once"
        return 1
      fi
      if [[ "$TEST_CASE" == missing-report ]]; then echo '{"events":[],"nextForwardToken":"done"}'; return; fi
      if [[ "$*" == *'--next-token done'* ]]; then echo '{"events":[],"nextForwardToken":"done"}'; return; fi
      # The first page has no tally: pagination is required to find it.
      if [[ "$*" != *'--next-token'* ]]; then echo '{"events":[{"message":"not json"}],"nextForwardToken":"next"}'; return; fi
      if [[ "$OPERATION" == inspect_cache ]]; then
        jq -n --arg actor "$(if [[ "$TEST_CASE" == inspect-wrong-metadata ]]; then echo https://other.example/users/other; else echo "$ACTOR_URI"; fi)" --arg canonical "$CANONICAL_ACCT" --arg transport "$TRANSPORT_ACCT" '{events:[{message:({msg:"[inspectFederatedIdentityCache] complete",operation:"inspect_cache",dryRun:true,identifiers:{actorUri:$actor,canonicalAcct:$canonical,transportAcct:$transport},observedAt:"2026-09-13T00:00:00.000Z",actorUriMatches:0,canonicalAcctMatches:0,transportAcctMatches:0,postSourceMatches:0} | tojson)}],nextForwardToken:"done"}'
        return
      fi
      jq -n --argjson dry "$DRY_RUN" '{events:[{message:({msg:"[reconcileMetaIdentityAndCrossposts] complete",dryRun:$dry,actorsExamined:2,actorsChanged:1,postsChanged:3,authorshipConflicts:0,mutesPreserved:1,clustersDissolved:1,postsExamined:5,postClustersCreated:0,refused:{oxy_identity_not_resolved:1}} | tojson)}],nextForwardToken:"done"}' ;;
    *) echo "Unexpected AWS operation $command" >&2; return 1 ;;
  esac
}
sleep() { :; }
export -f git aws sleep
run_case() {
  local name="$1" expected="$2"
  export TEST_CASE="$name"
  local case_dir="$test_directory/$name"
  mkdir -p "$case_dir/reviewed-preview"
  if [[ "$name" == apply || "$name" == wrong-preview || "$name" == wrong-preview-type ]]; then
    cp "$test_directory/success/reconciliation-report.json" "$case_dir/reviewed-preview/"
  fi
  if [[ "$name" == wrong-preview ]]; then
    sed -i "s/$DEPLOY_SHA/cccccccccccccccccccccccccccccccccccccccc/" "$case_dir/reviewed-preview/reconciliation-report.json"
  fi
  if [[ "$name" == wrong-preview-type ]]; then
    sed -i 's/"operation": "reconcile"/"operation": "inspect_cache"/' "$case_dir/reviewed-preview/reconciliation-report.json"
  fi
  : > "$test_directory/calls"
  local status=0
  (cd "$case_dir" && bash "$repository_root/.github/scripts/run-source-identity-reconciliation.sh") > "$case_dir/output" 2>&1 || status=$?
  if [[ "$expected" == pass ]]; then
    [[ "$status" == 0 ]] || { cat "$case_dir/output"; exit 1; }
    if [[ "$OPERATION" == inspect_cache ]]; then
      jq -e --arg sha "$DEPLOY_SHA" --arg digest "$EXPECTED_IMAGE_DIGEST" '.operation == "inspect_cache" and .dryRun == true and .sourceSha == $sha and .imageDigest == $digest and .observedAt == "2026-09-13T00:00:00.000Z" and .report == {actorUriMatches:0,canonicalAcctMatches:0,transportAcctMatches:0,postSourceMatches:0}' "$case_dir/reconciliation-report.json" >/dev/null
    else
      jq -e '.report.postsChanged == 3 and .report.refused.oxy_identity_not_resolved == 1' "$case_dir/reconciliation-report.json" >/dev/null
    fi
  else
    [[ "$status" != 0 ]] || { echo "Expected refusal: $name"; exit 1; }
    if [[ "$name" != missing-report && "$name" != task-failure && "$name" != inspect-wrong-metadata ]]; then
      ! grep -q '^ecs run-task$' "$test_directory/calls" || { echo "Started a task before refusing $name"; exit 1; }
    fi
  fi
  if grep -q '^ecs run-task$' "$test_directory/calls"; then
    jq -e --arg sha "$DEPLOY_SHA" '.sourceSha == $sha and .taskArn == "arn:fixture/task/one"' "$case_dir/reconciliation-run.json" >/dev/null
    jq -e '.taskStopped == true and (.exitCode | type) == "number"' "$case_dir/reconciliation-diagnostics.json" >/dev/null
  fi
  echo "PASS $name"
}
run_case success pass
run_case delayed-report pass
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
run_case wrong-preview-type fail
run_case apply pass
export DRY_RUN=true OPERATION=inspect_cache
run_case inspect pass
run_case inspect-wrong-metadata fail
export DRY_RUN=false
run_case inspect-write fail
export DRY_RUN=true OPERATION=arbitrary
run_case invalid-operation fail
export OPERATION=inspect_cache ACTOR_URI='https://cache.example/users/fresh;arbitrary'
run_case invalid-inspection-input fail
