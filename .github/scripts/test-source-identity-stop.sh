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

# Reuse the read-only provenance/log fixtures, then model only cancellation APIs.
eval "$(declare -f aws | sed '1s/aws/read_aws/')"
export SERVICE=mention DRY_RUN=true CONFIRM_WRITE= STOP_TASK_ARN=$FIXTURE_TASK GITHUB_OUTPUT=$scratch/output
aws() {
  case "$1 $2" in
    'ecs describe-tasks')
      local state=RUNNING
      [[ -f "$TEST_ROOT/stopped" ]] && state=STOPPED
      jq -n --arg task "$FIXTURE_TASK" --arg state "$state" --arg scenario "$TEST_CASE" '{failures:[],tasks:[{taskArn:$task,taskDefinitionArn:"fixture:1",startedBy:"gh-source-identity-reconcile",lastStatus:$state,group:(if $scenario == "service-group" then "service:mention" else "family:oxy-mention" end),containers:[{name:"backend"}],overrides:{containerOverrides:[{name:"backend",command:(if $scenario == "supervisor" then ["sh","-c","busybox timeout -s TERM -k 30 3300 bun \"$1\"; status=$?; exit \"$status\"","mention-source-identity","packages/backend/dist/src/scripts/reconcileMetaIdentityAndCrossposts.js"] else ["busybox","timeout","-s","TERM","-k","30","3300","bun",(if $scenario == "wrong-command" then "arbitrary.js" else "packages/backend/dist/src/scripts/reconcileMetaIdentityAndCrossposts.js" end)] end),environment:[{name:"DRY_RUN",value:(if $scenario == "apply-task" then "false" else "true" end)},{name:"CONFIRM_ADMIN_MUTATION",value:""}]}]}}]}' ;;
    'ecs describe-services') jq -n --arg scenario "$TEST_CASE" '{failures:[],services:[{status:"ACTIVE",taskDefinition:(if $scenario == "live-definition" then "fixture:1" else "fixture:2" end),deployments:[{taskDefinition:"fixture:2"}]}]}' ;;
    'ecs list-tasks') jq -n --arg scenario "$TEST_CASE" --arg task "$FIXTURE_TASK" '{taskArns:(if $scenario == "service-task" then [$task] else [] end)}' ;;
    'ecs stop-task')
      echo stop >> "$TEST_ROOT/calls"
      if [[ "$TEST_CASE" == stop-failure ]]; then echo PRIVATE_TOKEN >&2; return 1; fi
      [[ "$TEST_CASE" == never-stopped ]] || touch "$TEST_ROOT/stopped"
      echo '{}' ;;
    *) read_aws "$@" ;;
  esac
}
eval "$(declare -f gh | sed '1s/gh/read_gh/')"
gh() {
  if [[ "$1 $2" == 'run download' ]]; then
    local destination=${@: -1}
    mkdir -p "$destination"
    jq -n --arg task "$FIXTURE_TASK" --arg sha "$FIXTURE_SHA" --arg digest "$EXPECTED_IMAGE_DIGEST" --arg scenario "$TEST_CASE" '{operation:"reconcile",dryRun:($scenario != "apply-artifact"),taskArn:$task,sourceSha:$sha,imageDigest:$digest,taskDefinition:"fixture:1"}' > "$destination/reconciliation-run.json"
  else read_gh "$@"; fi
}
export -f aws read_aws gh read_gh
for TEST_CASE in success prepare supervisor apply-task apply-artifact wrong-command service-group live-definition service-task wrong-operator ambiguous-task wrong-image wrong-selector stop-failure never-stopped; do
  export TEST_CASE
  mkdir "$scratch/$TEST_CASE"
  rm -f "$scratch/stopped"
  : > "$scratch/calls"
  export STOP_TASK_ARN=$FIXTURE_TASK
  [[ "$TEST_CASE" != wrong-selector ]] || export STOP_TASK_ARN=arbitrary
  status=0
  mode=stop
  [[ "$TEST_CASE" != prepare ]] || mode=prepare
  (cd "$scratch/$TEST_CASE" && bash "$root/.github/scripts/stop-source-identity-preview.sh" "$mode") > "$scratch/$TEST_CASE/output" 2>&1 || status=$?
  if [[ "$TEST_CASE" == success || "$TEST_CASE" == supervisor ]]; then
    [[ $status == 0 ]] || { cat "$scratch/$TEST_CASE/output"; exit 1; }
    jq -e '.operation == "stop_preview" and .previewCancelled == true and .applyEligible == false and .taskStatus == "STOPPED"' "$scratch/$TEST_CASE/reconciliation-run.json" >/dev/null
  elif [[ "$TEST_CASE" == prepare ]]; then
    [[ $status == 0 ]]
    grep -Fxq "task_arn=$FIXTURE_TASK" "$GITHUB_OUTPUT"
    ! grep -q '^stop$' "$scratch/calls"
  else
    [[ $status != 0 ]] || { echo "Accepted $TEST_CASE"; exit 1; }
    if [[ "$TEST_CASE" == stop-failure || "$TEST_CASE" == never-stopped ]]; then
      jq -e '.previewCancelled == false and .applyEligible == false' "$scratch/$TEST_CASE/reconciliation-run.json" >/dev/null
    else ! grep -q '^stop$' "$scratch/calls"; fi
  fi
  ! grep -R -q PRIVATE_TOKEN "$scratch/$TEST_CASE"
  echo "PASS stop-preview $TEST_CASE"
done
