#!/usr/bin/env bash
set -euo pipefail
: "${DEPLOY_SHA:?}" "${EXPECTED_IMAGE_DIGEST:?}" "${DRY_RUN:?}" "${CLUSTER:?}" "${SERVICE:?}"
[[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ && "$EXPECTED_IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
operation="${OPERATION:-reconcile}"
case "$operation" in
  reconcile) report_message='[reconcileMetaIdentityAndCrossposts] complete' ;;
  inspect_cache)
    [[ "$DRY_RUN" == true ]] || { echo '::error::Cache inspection is read-only'; exit 1; }
    [[ "${ACTOR_URI:-}" =~ ^https://[a-z0-9.-]+/[A-Za-z0-9/._~%@:+-]+$ && ${#ACTOR_URI} -le 2048 ]] || exit 1
    for acct in "${CANONICAL_ACCT:-}" "${TRANSPORT_ACCT:-}"; do
      [[ "$acct" =~ ^[a-z0-9._-]+@[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$ && ${#acct} -le 320 ]] || exit 1
    done
    report_message='[inspectFederatedIdentityCache] complete'
    ;;
  *) echo '::error::Unsupported operation'; exit 1 ;;
esac
case "$DRY_RUN" in
  true) ;;
  false)
    [[ "${CONFIRM_WRITE:-}" == reconcileMetaIdentityAndCrossposts ]] || exit 1
    jq -e --arg sha "$DEPLOY_SHA" --arg digest "$EXPECTED_IMAGE_DIGEST" '.operation == "reconcile" and .sourceSha == $sha and .imageDigest == $digest and .dryRun == true and .exitCode == 0 and .report.actorsExamined >= 0 and .report.postsExamined >= 0' reviewed-preview/reconciliation-report.json >/dev/null
    ;;
  *) exit 1 ;;
esac
# The deployment marker is written only after a successful backend rollout.
git fetch --force --no-tags origin '+refs/tags/deployed/backend:refs/tags/deployed/backend'
[[ "$(git rev-parse 'refs/tags/deployed/backend^{commit}')" == "$DEPLOY_SHA" ]] || { echo '::error::Current main is not the recorded backend deployment'; exit 1; }
work_dir=$(mktemp -d)
task_arn=''
task_stopped=true
cleanup() {
  status=$?
  if [[ "$task_stopped" != true && -n "$task_arn" ]]; then
    echo "::warning::Task $task_arn may still run until its container timeout; inspect ECS."
  fi
  rm -rf -- "$work_dir"
  exit "$status"
}
trap cleanup EXIT
aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --output json > "$work_dir/service.json"
jq -e '.failures | length == 0' "$work_dir/service.json" >/dev/null
jq -e '.services | length == 1' "$work_dir/service.json" >/dev/null
jq -e '.services[0] | .status == "ACTIVE" and .desiredCount > 0 and .runningCount == .desiredCount and .pendingCount == 0 and (.deployments | length == 1) and .deployments[0].rolloutState == "COMPLETED"' "$work_dir/service.json" >/dev/null
live_task_def=$(jq -r '.services[0].taskDefinition' "$work_dir/service.json")
aws ecs describe-task-definition --task-definition "$live_task_def" --query taskDefinition --output json > "$work_dir/taskdef.json"
# There must be exactly one backend container; never silently choose a sidecar.
jq -e '.containerDefinitions | length == 1' "$work_dir/taskdef.json" >/dev/null
container=$(jq -r '.containerDefinitions[0].name' "$work_dir/taskdef.json")
image=$(jq -r '.containerDefinitions[0].image' "$work_dir/taskdef.json")
[[ "$image" == "237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/mention@$EXPECTED_IMAGE_DIGEST" ]] || { echo '::error::Live image differs from the reviewed immutable digest'; exit 1; }
# BatchGetImage is the ECR pull permission, not the unavailable DescribeImages permission.
aws ecr batch-get-image --repository-name oxy/mention --image-ids "imageTag=$DEPLOY_SHA" --output json > "$work_dir/image.json"
jq -e --arg digest "$EXPECTED_IMAGE_DIGEST" '.failures | length == 0' "$work_dir/image.json" >/dev/null
jq -e --arg digest "$EXPECTED_IMAGE_DIGEST" '.images | length == 1 and .[0].imageId.imageDigest == $digest' "$work_dir/image.json" >/dev/null
jq '{awsvpcConfiguration:.services[0].networkConfiguration.awsvpcConfiguration}' "$work_dir/service.json" > "$work_dir/network.json"
jq -e '.awsvpcConfiguration | (.subnets | length > 0) and (.securityGroups | length > 0) and (.assignPublicIp == "ENABLED" or .assignPublicIp == "DISABLED")' "$work_dir/network.json" >/dev/null
jq -n --arg name "$container" --arg dry "$DRY_RUN" --arg operation "$operation" --arg actor "${ACTOR_URI:-}" --arg canonical "${CANONICAL_ACCT:-}" --arg transport "${TRANSPORT_ACCT:-}" '
  {containerOverrides:[{name:$name,
    command: (["busybox","timeout","-s","TERM","-k","30","3300","bun"] +
      [if $operation == "inspect_cache" then "packages/backend/dist/src/scripts/inspectFederatedIdentityCache.js" else "packages/backend/dist/src/scripts/reconcileMetaIdentityAndCrossposts.js" end]),
    environment: (if $operation == "inspect_cache" then [
      {name:"DRY_RUN",value:"true"},{name:"CONFIRM_ADMIN_MUTATION",value:""},
      {name:"INSPECT_ACTOR_URI",value:$actor},{name:"INSPECT_CANONICAL_ACCT",value:$canonical},{name:"INSPECT_TRANSPORT_ACCT",value:$transport}
    ] else [{name:"DRY_RUN",value:$dry},{name:"CONFIRM_ADMIN_MUTATION",value:(if $dry == "false" then "reconcileMetaIdentityAndCrossposts" else "" end)}] end)}]}
' > "$work_dir/overrides.json"
# Re-read the live definition just before the one-shot. Never update the service.
[[ "$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].taskDefinition' --output text)" == "$live_task_def" ]] || exit 1
aws ecs run-task --cluster "$CLUSTER" --task-definition "$live_task_def" --launch-type FARGATE --network-configuration "file://$work_dir/network.json" --overrides "file://$work_dir/overrides.json" --started-by gh-source-identity-reconcile > "$work_dir/run.json"
jq -e '.failures | length == 0' "$work_dir/run.json" >/dev/null
task_arn=$(jq -er '.tasks[0].taskArn' "$work_dir/run.json")
task_stopped=false
echo "Reconciliation task: $task_arn"
for ((elapsed=0; elapsed<3600; elapsed+=15)); do
  aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task_arn" --output json > "$work_dir/result.json"
  if [[ "$(jq -r '.tasks[0].lastStatus' "$work_dir/result.json")" == STOPPED ]]; then task_stopped=true; break; fi
  sleep 15
done
[[ "$task_stopped" == true ]] || { echo '::error::Reconciliation exceeded its wait bound'; exit 1; }
exit_code=$(jq -er --arg name "$container" '.tasks[0].containers[] | select(.name == $name) | .exitCode' "$work_dir/result.json")
log_group=$(jq -er '.containerDefinitions[0].logConfiguration.options["awslogs-group"]' "$work_dir/taskdef.json")
log_prefix=$(jq -er '.containerDefinitions[0].logConfiguration.options["awslogs-stream-prefix"]' "$work_dir/taskdef.json")
# Read every page; the final tally may follow thousands of source-level notices.
# CloudWatch may trail STOPPED briefly. Retry collection, never infer completion.
for ((log_attempt=1; log_attempt<=5; log_attempt++)); do
  token=''
  : > "$work_dir/messages.jsonl"
  for ((page=0; page<10000; page++)); do
    args=(logs get-log-events --log-group-name "$log_group" --log-stream-name "$log_prefix/$container/${task_arn##*/}" --start-from-head --output json)
    if [[ -n "$token" ]]; then args+=(--next-token "$token"); fi
    if ! aws "${args[@]}" > "$work_dir/logs.json"; then
      : > "$work_dir/messages.jsonl"
      break
    fi
    jq -c --arg message "$report_message" '.events[].message | fromjson? | select(.msg == $message)' "$work_dir/logs.json" >> "$work_dir/messages.jsonl"
    next=$(jq -r '.nextForwardToken' "$work_dir/logs.json")
    [[ "$next" == "$token" ]] && break
    token="$next"
  done
  [[ "$page" -lt 10000 ]] || { echo '::error::Log paging limit reached; result is incomplete'; exit 1; }
  [[ -s "$work_dir/messages.jsonl" ]] && break
  if [[ "$log_attempt" -lt 5 ]]; then sleep 2; fi
done
# Preserve counts and inspected public selectors, never raw logs, profiles or inherited secrets.
jq -s -e --arg sha "$DEPLOY_SHA" --arg digest "$EXPECTED_IMAGE_DIGEST" --argjson dry "$DRY_RUN" --argjson code "$exit_code" --arg operation "$operation" --arg actor "${ACTOR_URI:-}" --arg canonical "${CANONICAL_ACCT:-}" --arg transport "${TRANSPORT_ACCT:-}" '
  if length != 1 then error("Expected exactly one completed reconciliation report") else .[0] end
  | if .dryRun != $dry then error("Task reported a different execution mode") else . end
  | if $operation == "inspect_cache" then
      if .operation != "inspect_cache" or (.observedAt | type) != "string" or .identifiers != {actorUri:$actor,canonicalAcct:$canonical,transportAcct:$transport} then error("Invalid cache inspection metadata") else . end
      | {operation:$operation,sourceSha:$sha,imageDigest:$digest,dryRun:true,exitCode:$code,observedAt,identifiers,report:{actorUriMatches,canonicalAcctMatches,transportAcctMatches,postSourceMatches}}
      | if ([.report[] | (type == "number" and . >= 0 and floor == .)] | all) then . else error("Invalid cache inspection counts") end
    else
      {operation:$operation,sourceSha:$sha,imageDigest:$digest,dryRun:$dry,exitCode:$code,report:{actorsExamined,actorsChanged,postsChanged,authorshipConflicts,mutesPreserved,clustersDissolved,postsExamined,postClustersCreated,refused}}
      | if ([.report | del(.refused) | .[] | (type == "number" and . >= 0 and floor == .)] | all) and (.report.refused | type == "object") then . else error("Invalid reconciliation summary") end
    end
' "$work_dir/messages.jsonl" > "$work_dir/report.json"
mv "$work_dir/report.json" reconciliation-report.json
cat reconciliation-report.json
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  { echo '### Source identity reconciliation'; echo '```json'; cat reconciliation-report.json; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
fi
[[ "$exit_code" == 0 ]] || { echo "::error::Task failed with exit code $exit_code"; exit 1; }
