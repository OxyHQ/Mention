#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
export RECOVERY_RUN_ID=123 GITHUB_REPOSITORY=OxyHQ/Mention ACTOR=fixture CLUSTER=oxy-cluster
export EXPECTED_IMAGE_DIGEST=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
export TEST_ROOT=$scratch TEST_CASE=success
export FIXTURE_TASK=arn:aws:ecs:us-west-2:237343248947:task/oxy-cluster/0123456789abcdef0123456789abcdef
export FIXTURE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
gh() {
  if [[ "$1" == api ]]; then
    jq -n --arg actor "$(if [[ "$TEST_CASE" == wrong-operator ]]; then echo other; else echo fixture; fi)" --arg sha "$FIXTURE_SHA" '{head_branch:"main",event:"workflow_dispatch",status:"completed",actor:{login:$actor},triggering_actor:{login:$actor},path:".github/workflows/run-source-identity-reconciliation.yml",head_sha:$sha}'
  else
    printf 'reconcile\tReconcile with the exact deployed image\t2026-09-13T07:49:29.4884237Z Reconciliation task: %s\n' "$FIXTURE_TASK"
    if [[ "$TEST_CASE" == ambiguous-task ]]; then printf 'reconcile\tReconcile with the exact deployed image\t2026-09-13T07:49:29.4884237Z Reconciliation task: arn:aws:ecs:us-west-2:237343248947:task/oxy-cluster/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'; fi
  fi
}
aws() {
  local command="$1 $2"
  echo "$command" >> "$TEST_ROOT/calls"
  case "$command" in
    'ecs describe-tasks') jq -n --arg task "$FIXTURE_TASK" --arg state "$(if [[ "$TEST_CASE" == running-* ]]; then echo RUNNING; elif [[ "$TEST_CASE" == pending-task ]]; then echo PENDING; else echo STOPPED; fi)" --arg started "$(if [[ "$TEST_CASE" == wrong-task ]]; then echo unrelated; else echo gh-source-identity-reconcile; fi)" '{failures:[],tasks:[{taskArn:$task,startedBy:$started,lastStatus:$state,taskDefinitionArn:"fixture:1",containers:[{name:"backend",exitCode:(if $state == "STOPPED" then 1 else null end)}]}]}' ;;
    'ecs describe-task-definition') jq -n --arg image "237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/mention@$EXPECTED_IMAGE_DIGEST" '{containerDefinitions:[{name:"backend",image:$image,logConfiguration:{options:{"awslogs-group":"group","awslogs-stream-prefix":"ecs"}}}]}' ;;
    'ecr batch-get-image') jq -n --arg digest "$(if [[ "$TEST_CASE" == wrong-image ]]; then echo sha256:wrong; else echo "$EXPECTED_IMAGE_DIGEST"; fi)" '{failures:[],images:[{imageId:{imageDigest:$digest}}]}' ;;
    'logs get-log-events')
      if [[ "$TEST_CASE" == no-terminal ]]; then
        echo '{"events":[],"nextForwardToken":"done"}'
        return
      fi
      if [[ ( "$TEST_CASE" == delayed-diagnostics || "$TEST_CASE" == delayed-summary ) && "$*" != *--next-token* && ! -f "$TEST_ROOT/empty-stream-$TEST_CASE-once" ]]; then
        touch "$TEST_ROOT/empty-stream-$TEST_CASE-once"
        echo '{"events":[],"nextForwardToken":"done"}'
        return
      fi
      if [[ "$TEST_CASE" == log-failure ]]; then return 1; fi
      if [[ "$TEST_CASE" == mixed-errors && "$*" != *--next-token* ]]; then
        jq -n '{events:((["PRIVATE_TOKEN",["PRIVATE_TOKEN"],null] | map({message:({level:"error",msg:"runtime failed",error:.,err:.} | tojson)})) + [{message:"[1,2,3]"},{message:"null"},{message:({level:"warn",msg:12,error:"PRIVATE_TOKEN"} | tojson)}]),nextForwardToken:"mixed"}'
        return
      fi
      if [[ "$*" == *'--next-token done'* ]]; then echo '{"events":[],"nextForwardToken":"done"}'; return; fi
      if [[ "$TEST_CASE" == *summary || "$TEST_CASE" == running-progress ]]; then
        jq -n --arg scenario "$TEST_CASE" '
          {msg:"[reconcileMetaIdentityAndCrossposts] complete",dryRun:true,actorsExamined:300,actorsChanged:7,postsChanged:12,authorshipConflicts:0,mutesPreserved:0,clustersDissolved:0,postsExamined:500,postClustersCreated:0,refused:{oxy_identity_not_resolved:2,PRIVATE_TOKEN:1},profile:"PRIVATE_TOKEN"} as $summary |
          {events:([{message:({msg:"[reconcileMetaIdentityAndCrossposts] progress",phase:"actors",dryRun:true,batchesCompleted:1,actorsExamined:100,profile:"PRIVATE_TOKEN",postsChanged:"PRIVATE_TOKEN"}|tojson)},
                    {message:({msg:"[reconcileMetaIdentityAndCrossposts] progress",phase:"actors",dryRun:true,batchesCompleted:3,actorsExamined:300,profile:"PRIVATE_TOKEN"}|tojson)}] +
            (if $scenario == "running-progress" then []
             elif $scenario == "invalid-summary" then [{message:($summary + {actorsChanged:"PRIVATE_TOKEN"}|tojson)}]
             elif $scenario == "duplicate-summary" then [{message:($summary|tojson)},{message:($summary|tojson)}]
             elif $scenario == "ambiguous-summary" then [{message:($summary|tojson)},{message:($summary + {actorsExamined:301}|tojson)}]
             else [{message:($summary|tojson)}] end)),nextForwardToken:"done"}'
        return
      fi
      jq -n '{events:[{message:({level:"error",msg:"[reconcileMetaIdentityAndCrossposts] failed",error:{name:"ZodError",message:"PRIVATE_TOKEN https://secret.invalid/private",issues:[{code:"invalid_type",path:["identities",0,"userId"],input:"PRIVATE_TOKEN"}]}} | tojson)}],nextForwardToken:"done"}' ;;
    *) echo "Unexpected write or operation: $command" >&2; return 1 ;;
  esac
}
sleep() { :; }
export -f gh aws sleep
for TEST_CASE in success mixed-errors delayed-diagnostics wrong-operator ambiguous-task wrong-task wrong-image log-failure no-terminal running-task pending-task complete-summary duplicate-summary ambiguous-summary invalid-summary delayed-summary running-progress; do
  export TEST_CASE
  mkdir "$scratch/$TEST_CASE"
  : > "$scratch/calls"
  status=0
  (cd "$scratch/$TEST_CASE" && bash "$root/.github/scripts/recover-source-identity-report.sh") > "$scratch/$TEST_CASE/output" 2>&1 || status=$?
  if [[ "$TEST_CASE" == success || "$TEST_CASE" == mixed-errors || "$TEST_CASE" == delayed-diagnostics || "$TEST_CASE" == complete-summary || "$TEST_CASE" == duplicate-summary || "$TEST_CASE" == delayed-summary ]]; then
    [[ "$status" == 0 ]] || { cat "$scratch/$TEST_CASE/output"; exit 1; }
    if [[ "$TEST_CASE" == *summary ]]; then
      jq -e '.recoveryComplete and .summaryStatus == "valid" and .completeSummary.counts.actorsExamined == 300 and .completeSummary.refusedTotal == 3 and (.latestProgress | length == 1) and .latestProgress[0].batchesCompleted == 3 and .latestProgress[0].counts == {actorsExamined:300}' "$scratch/$TEST_CASE/reconciliation-diagnostics.json" >/dev/null
    else
    jq -e '.exitCode == 1 and .logsComplete and ([.failureCategories[] | select(.category == "response_validation" and .validationIssues == [{code:"invalid_type",path:["identities",0,"userId"]}])] | length == 1)' "$scratch/$TEST_CASE/reconciliation-diagnostics.json" >/dev/null
    fi
  else [[ "$status" != 0 ]] || { echo "Accepted $TEST_CASE"; exit 1; }; fi
  if [[ "$TEST_CASE" == running-task || "$TEST_CASE" == pending-task ]]; then
    jq -e --arg state "$(if [[ "$TEST_CASE" == running-* ]]; then echo RUNNING; else echo PENDING; fi)" '.taskStatus == $state and .taskStopped == false and .recoveryComplete == false and .exitCode == null and .terminalEventObserved == true' "$scratch/$TEST_CASE/reconciliation-diagnostics.json" >/dev/null
    [[ -s "$scratch/$TEST_CASE/reconciliation-run.json" ]]
  fi
  if [[ "$TEST_CASE" == ambiguous-summary || "$TEST_CASE" == invalid-summary ]]; then
    jq -e '.recoveryComplete == false and .completeSummary == null and (.summaryStatus == "ambiguous" or .summaryStatus == "invalid")' "$scratch/$TEST_CASE/reconciliation-diagnostics.json" >/dev/null
  fi
  if [[ "$TEST_CASE" == running-progress ]]; then
    jq -e '.taskStatus == "RUNNING" and .terminalEventObserved == false and .recoveryComplete == false and .latestProgress[0].counts.actorsExamined == 300' "$scratch/$TEST_CASE/reconciliation-diagnostics.json" >/dev/null
  fi
  if [[ "$TEST_CASE" == log-failure ]]; then
    jq -e '.taskStatus == "STOPPED" and .logsComplete == false and .recoveryComplete == false' "$scratch/$TEST_CASE/reconciliation-diagnostics.json" >/dev/null
    [[ -s "$scratch/$TEST_CASE/reconciliation-run.json" ]]
  fi
  if [[ "$TEST_CASE" == no-terminal ]]; then
    jq -e '.logsComplete == true and .terminalEventObserved == false and .failureCategories == []' "$scratch/$TEST_CASE/reconciliation-diagnostics.json" >/dev/null
    [[ -s "$scratch/$TEST_CASE/reconciliation-run.json" ]]
  fi
  ! grep -R -q PRIVATE_TOKEN "$scratch/$TEST_CASE"
  ! grep -q 'run-task\|register-task-definition\|update-service\|stop-task' "$scratch/calls"
  echo "PASS recovery $TEST_CASE"
done
