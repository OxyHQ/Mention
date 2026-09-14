#!/usr/bin/env bash
# Cancel only a provenance-verified standalone read-only preview; never an apply.
set -euo pipefail
: "${RECOVERY_RUN_ID:?}" "${GITHUB_REPOSITORY:?}" "${ACTOR:?}" "${EXPECTED_IMAGE_DIGEST:?}" "${CLUSTER:?}" "${SERVICE:?}"
mode=${1:?prepare or stop}
[[ "$mode" == prepare || "$mode" == stop ]] || exit 1
[[ "${DRY_RUN:-}" == true && -z "${CONFIRM_WRITE:-}" ]] || exit 1
scratch=$(mktemp -d)
trap 'status=$?; rm -rf -- "$scratch"; if (( status != 0 )); then echo "::error::Preview cancellation validation or operation failed; available sanitized evidence retained"; fi' EXIT
exec 2> "$scratch/private-errors"
# Recovery authenticates original workflow/operator, trusted launcher ARN, source
# image and task ownership before writing its sanitized snapshot. An unfinished
# preview intentionally returns failure, so require newly generated evidence.
scripts=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
mkdir "$scratch/readback"
(cd "$scratch/readback" && bash "$scripts/recover-source-identity-report.sh") > "$scratch/recovery-output" 2>&1 || true
jq -e '.operation == "recover_report" and .readOnly == true' "$scratch/readback/reconciliation-run.json" >/dev/null
jq -e '.logsComplete == true' "$scratch/readback/reconciliation-diagnostics.json" >/dev/null
cp "$scratch/readback/reconciliation-run.json" reconciliation-run.json
cp "$scratch/readback/reconciliation-diagnostics.json" reconciliation-diagnostics.json
gh run download "$RECOVERY_RUN_ID" --repo "$GITHUB_REPOSITORY" --name source-identity-reconciliation --dir "$scratch/original" > "$scratch/download-output" 2>&1
jq -s -e '.[0] as $current | .[1] | .operation == "reconcile" and .dryRun == true and .sourceSha == $current.sourceSha and .imageDigest == $current.imageDigest and .taskArn == $current.taskArn and .taskDefinition == $current.taskDefinition' reconciliation-run.json "$scratch/original/reconciliation-run.json" >/dev/null
task=$(jq -er '.taskArn' reconciliation-run.json)
definition=$(jq -er '.taskDefinition' reconciliation-run.json)
aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --output json > "$scratch/service.json"
jq -e --arg definition "$definition" '(.failures | length == 0) and (.services | length == 1) and .services[0].status == "ACTIVE" and .services[0].taskDefinition != $definition and all(.services[0].deployments[]; .taskDefinition != $definition)' "$scratch/service.json" >/dev/null
aws ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" --output json > "$scratch/service-tasks.json"
jq -e --arg task "$task" '(.nextToken == null) and (.taskArns | index($task) == null)' "$scratch/service-tasks.json" >/dev/null
aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task" --output json > "$scratch/task.json"
aws ecs describe-task-definition --task-definition "$definition" --query taskDefinition --output json > "$scratch/definition.json"
container=$(jq -er '.containerDefinitions | if length == 1 then .[0].name else error("Expected one container") end' "$scratch/definition.json")
jq -e --arg task "$task" --arg definition "$definition" --arg container "$container" '
  (.failures | length == 0) and (.tasks | length == 1) and (.tasks[0] |
    .taskArn == $task and .taskDefinitionArn == $definition and .startedBy == "gh-source-identity-reconcile" and
    (.group | startswith("family:")) and (.lastStatus | IN("RUNNING", "PENDING", "STOPPED")) and
    (.overrides.containerOverrides | length == 1 and (.[0] |
      .name == $container and
      (.command == ["busybox","timeout","-s","TERM","-k","30","3300","bun","packages/backend/dist/src/scripts/reconcileMetaIdentityAndCrossposts.js"] or
       .command == ["sh","-c","busybox timeout -s TERM -k 30 3300 bun \"$1\"; status=$?; exit \"$status\"","mention-source-identity","packages/backend/dist/src/scripts/reconcileMetaIdentityAndCrossposts.js"]) and
      (.environment | sort_by(.name)) == [{name:"CONFIRM_ADMIN_MUTATION",value:""},{name:"DRY_RUN",value:"true"}]
    )))' "$scratch/task.json" >/dev/null
jq '. + {operation:"stop_preview",previewCancelled:false,applyEligible:false,diagnosticsPhase:"before_stop",readOnly:false,previewReadOnly:true,stopRequested:false}' reconciliation-run.json > "$scratch/snapshot.json"
mv "$scratch/snapshot.json" reconciliation-run.json
if [[ "$mode" == prepare ]]; then
  printf 'task_arn=%s\n' "$task" >> "${GITHUB_OUTPUT:?}"
  exit 0
fi
[[ "${STOP_TASK_ARN:?}" == "$task" ]] || exit 1
stop_requested=false
if [[ $(jq -r '.tasks[0].lastStatus' "$scratch/task.json") != STOPPED ]]; then
  # Discard raw AWS errors, which can contain environment overrides.
  if ! aws ecs stop-task --cluster "$CLUSTER" --task "$task" --reason 'Cancel authenticated read-only legacy source identity preview' > "$scratch/stop.json" 2> "$scratch/stop-error"; then
    echo '::error::Stopping the authenticated preview failed; pre-stop evidence retained'
    exit 1
  fi
  stop_requested=true
  jq '. + {stopRequested:true}' reconciliation-run.json > "$scratch/requested.json"
  mv "$scratch/requested.json" reconciliation-run.json
fi
# Bound the entire observation phase, including AWS request latency.
cat > "$scratch/poll.sh" <<'POLL'
  set -euo pipefail
  for attempt in $(seq 1 24); do
    aws ecs describe-tasks --cluster "$1" --tasks "$2" --output json > "$3/stopped.json" 2> "$3/poll-error" || exit 1
    jq -e --arg task "$2" '(.failures | length == 0) and (.tasks | length == 1) and .tasks[0].taskArn == $task' "$3/stopped.json" >/dev/null
    [[ $(jq -r '.tasks[0].lastStatus' "$3/stopped.json") != STOPPED ]] || exit 0
    sleep 5
  done
  exit 1
POLL
if timeout 120 bash "$scratch/poll.sh" "$CLUSTER" "$task" "$scratch"; then
  jq --argjson requested "$stop_requested" '. + {taskStatus:"STOPPED",previewCancelled:$requested,applyEligible:false}' reconciliation-run.json > "$scratch/cancelled.json"
  mv "$scratch/cancelled.json" reconciliation-run.json
  exit 0
fi
echo '::error::Preview stop was not confirmed within 120 seconds; pre-stop evidence retained'
exit 1
