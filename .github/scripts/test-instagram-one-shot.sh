#!/usr/bin/env bash
# Fixture test for run-instagram-one-shot.sh: AWS, git and sleep are shell
# functions, so every refusal is proven to happen BEFORE `ecs run-task`.
set -euo pipefail
repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_directory=$(mktemp -d)
trap 'rm -rf -- "$test_directory"' EXIT
export DEPLOY_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export EXPECTED_IMAGE_DIGEST=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
export CLUSTER=fixture-cluster SERVICE=fixture-service
export TEST_ROOT="$test_directory"
export TEST_CASE=success
export DRY_RUN=true SCRIPT=repairInstagramReelPosters CONFIRM_WRITE='' REPAIR_DEPTH=''
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
      jq -n --arg image "237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/mention@$EXPECTED_IMAGE_DIGEST" '{containerDefinitions:[{name:"backend",image:$image,logConfiguration:{options:{"awslogs-group":"/oxy/ecs","awslogs-stream-prefix":"mention"}}}]}' ;;
    'ecr batch-get-image')
      local digest="$EXPECTED_IMAGE_DIGEST"
      if [[ "$TEST_CASE" == wrong-image ]]; then digest=sha256:wrong; fi
      jq -n --arg digest "$digest" '{failures:[],images:[{imageId:{imageDigest:$digest}}]}' ;;
    'ecs run-task')
      local overrides=''
      while [[ $# -gt 0 ]]; do
        case "$1" in --overrides) overrides="${2#file://}";; esac
        shift
      done
      cp "$overrides" "$TEST_ROOT/overrides.json"
      jq -e --arg dry "$DRY_RUN" --arg script "$SCRIPT" --arg depth "$REPAIR_DEPTH" '.containerOverrides[0]
        | .command[-1] == ("packages/backend/dist/src/scripts/" + $script + ".js")
        and .command[0:2] == ["sh","-c"]
        and .environment[0] == {name:"DRY_RUN",value:$dry}
        and .environment[1] == {name:"CONFIRM_ADMIN_MUTATION",value:(if $dry == "false" then $script else "" end)}
        and (if $depth == "" then (.environment | length == 2) else .environment[2] == {name:"REPAIR_DEPTH",value:$depth} end)' "$overrides" >/dev/null
      echo '{"failures":[],"tasks":[{"taskArn":"arn:aws:ecs:us-west-2:1:task/oxy-cluster/fixturetask"}]}' ;;
    'ecs describe-tasks')
      local code=0
      case "$TEST_CASE" in task-failure) code=1 ;; incomplete) code=75 ;; timed-out) code=143 ;; esac
      jq -n --argjson code "$code" '{tasks:[{lastStatus:"STOPPED",containers:[{name:"backend",exitCode:$code}]}]}' ;;
    'logs get-log-events')
      [[ "$*" == *'--log-stream-name mention/backend/fixturetask'* ]] || { echo "wrong stream: $*" >&2; return 1; }
      if [[ "$TEST_CASE" == delayed-report && ! -f "$TEST_ROOT/delayed-once" ]]; then touch "$TEST_ROOT/delayed-once"; return 1; fi
      if [[ "$TEST_CASE" == missing-report || "$TEST_CASE" == timed-out ]]; then echo '{"events":[],"nextForwardToken":"done"}'; return; fi
      if [[ "$*" == *'--next-token done'* ]]; then echo '{"events":[],"nextForwardToken":"done"}'; return; fi
      # The first page carries a candidate but no tally: paging is required.
      if [[ "$*" != *'--next-token'* ]]; then
        jq -n --arg msg "[$SCRIPT] candidate" '{events:[{message:"not json"},{message:({msg:$msg,postId:"p1",sourceKey:"instagram:Abc",slots:[0],dryRun:true} | tojson)}],nextForwardToken:"next"}'
        return
      fi
      local dry="$DRY_RUN"
      if [[ "$TEST_CASE" == wrong-mode ]]; then dry=false; fi
      if [[ "$SCRIPT" == repairInstagramReelPosters ]]; then
        jq -n --argjson dry "$dry" '{events:[{message:({msg:"[repairInstagramReelPosters] complete",dryRun:$dry,actors:3,checked:40,candidates:1,repaired:0,waiting:0,gone:0,stopped:0} | tojson)}],nextForwardToken:"done"}'
      else
        jq -n --argjson dry "$dry" '{events:[{message:({msg:"[backfillInstagramSourceKeys] complete",dryRun:$dry,actors:2,candidates:7,written:0,conflicts:0,claimed:0,validated:[],unvalidated:[]} | tojson)}],nextForwardToken:"done"}'
      fi ;;
    *) echo "Unexpected AWS operation $command" >&2; return 1 ;;
  esac
}
sleep() { :; }
export -f git aws sleep
run_case() {
  local name="$1" expected="$2"
  export TEST_CASE="$name"
  local case_dir="$test_directory/$SCRIPT-$name"
  mkdir -p "$case_dir/reviewed-preview"
  if [[ "$name" == apply* || "$name" == wrong-preview* ]]; then
    cp "$test_directory/$SCRIPT-success/instagram-one-shot-report.json" "$case_dir/reviewed-preview/"
  fi
  if [[ "$name" == wrong-preview-source ]]; then
    sed -i "s/$DEPLOY_SHA/cccccccccccccccccccccccccccccccccccccccc/" "$case_dir/reviewed-preview/instagram-one-shot-report.json"
  fi
  if [[ "$name" == wrong-preview-script ]]; then
    jq '.script = "someOtherScript"' "$case_dir/reviewed-preview/instagram-one-shot-report.json" > "$case_dir/p.json"
    mv "$case_dir/p.json" "$case_dir/reviewed-preview/instagram-one-shot-report.json"
  fi
  : > "$test_directory/calls"
  local status=0
  (cd "$case_dir" && bash "$repository_root/.github/scripts/run-instagram-one-shot.sh") > "$case_dir/output" 2>&1 || status=$?
  if [[ "$expected" == pass ]]; then
    [[ "$status" == 0 ]] || { cat "$case_dir/output"; echo "FAIL $SCRIPT $name"; exit 1; }
    jq -e --arg script "$SCRIPT" --arg sha "$DEPLOY_SHA" '.script == $script and .sourceSha == $sha and (.report | length > 0)' "$case_dir/instagram-one-shot-report.json" >/dev/null
    jq -e '.logGroup == "/oxy/ecs" and .logStream == "mention/backend/fixturetask"' "$case_dir/instagram-one-shot-run.json" >/dev/null
    if [[ "$SCRIPT" == repairInstagramReelPosters ]]; then
      jq -e '.report == {actors:3,checked:40,candidates:1,repaired:0,waiting:0,gone:0,stopped:0} and .candidates == [{postId:"p1",sourceKey:"instagram:Abc",slots:[0]}]' "$case_dir/instagram-one-shot-report.json" >/dev/null
    else
      jq -e '.report == {actors:2,candidates:7,written:0,conflicts:0,claimed:0}' "$case_dir/instagram-one-shot-report.json" >/dev/null
    fi
  else
    [[ "$status" != 0 ]] || { cat "$case_dir/output"; echo "Expected refusal: $SCRIPT $name"; exit 1; }
    case "$name" in
      missing-report|task-failure|timed-out|wrong-mode) ;;
      *) ! grep -q '^ecs run-task$' "$test_directory/calls" || { echo "Started a task before refusing $name"; exit 1; } ;;
    esac
  fi
  echo "PASS $SCRIPT $name"
}

for script in repairInstagramReelPosters backfillInstagramSourceKeys; do
  export SCRIPT="$script" DRY_RUN=true CONFIRM_WRITE='' REPAIR_DEPTH=''
  run_case success pass
  run_case delayed-report pass
  run_case incomplete pass
  run_case wrong-image fail
  run_case stale-source fail
  run_case rolling fail
  run_case missing-report fail
  run_case timed-out fail
  run_case task-failure fail
  run_case wrong-mode fail
  export DRY_RUN=garbled
  run_case invalid-mode fail
  export DRY_RUN=false
  run_case unconfirmed-write fail
  export CONFIRM_WRITE="$script"
  run_case missing-preview fail
  run_case wrong-preview-source fail
  run_case wrong-preview-script fail
  run_case apply pass
done
grep -q 'timeout at its 3300 s bound\|stopped at its 3300 s bound' "$test_directory/backfillInstagramSourceKeys-timed-out/output"
grep -q 'finished with work left over' "$test_directory/repairInstagramReelPosters-incomplete/output"

export SCRIPT=repairInstagramReelPosters DRY_RUN=true CONFIRM_WRITE='' REPAIR_DEPTH=250
run_case depth pass
jq -e '.containerOverrides[0].environment[2] == {name:"REPAIR_DEPTH",value:"250"}' "$test_directory/overrides.json" >/dev/null
export REPAIR_DEPTH='1;rm -rf /'
run_case invalid-depth fail
export REPAIR_DEPTH=5000
run_case depth-too-large fail
export SCRIPT=backfillInstagramSourceKeys REPAIR_DEPTH=10
run_case depth-wrong-script fail
export SCRIPT=eraseOxyAccount REPAIR_DEPTH=''
run_case unsupported-script fail
echo "all instagram one-shot cases passed"
