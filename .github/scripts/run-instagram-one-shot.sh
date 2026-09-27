#!/usr/bin/env bash
# Run ONE reviewed backend maintenance script as an ECS one-shot on the exact
# deployed backend image (never a rebuild), and turn its `[<script>] complete`
# log line into a structured report. Driven by run-instagram-one-shot.yml
# (the two Instagram scripts) and run-banner-mirror-recovery.yml (the banner
# recovery). The file keeps its first name so a preview recorded by an earlier
# run stays valid.
#
#   SCRIPT          repairInstagramReelPosters | backfillInstagramSourceKeys
#                   | queueFederatedBannerMirrors
#   DRY_RUN         true | false (anything else is refused)
#   CONFIRM_WRITE   apply only: the script name, typed back
#   REPAIR_DEPTH    repairInstagramReelPosters only, optional: 1..1000
#   INCLUDE_EXISTING, RETRY_FAILED
#                   queueFederatedBannerMirrors only, optional: true | false
#                   (default false). A write must use the SAME values as the
#                   reviewed dry run.
#   reviewed-preview/instagram-one-shot-report.json
#                   apply only: the successful dry run of the same script,
#                   source sha and image digest
set -euo pipefail
: "${DEPLOY_SHA:?}" "${EXPECTED_IMAGE_DIGEST:?}" "${DRY_RUN:?}" "${CLUSTER:?}" "${SERVICE:?}" "${SCRIPT:?}"
[[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ && "$EXPECTED_IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo '::error::Invalid source sha or image digest'; exit 1; }

# The only scripts this runner will start, and the report fields each one logs.
case "$SCRIPT" in
  repairInstagramReelPosters)
    report_fields='actors,checked,candidates,repaired,waiting,gone,stopped'
    ;;
  backfillInstagramSourceKeys)
    report_fields='actors,candidates,written,conflicts,claimed'
    ;;
  queueFederatedBannerMirrors)
    report_fields='actors,withoutBanner,queued,retried,failedDue'
    ;;
  *) echo '::error::Unsupported script'; exit 1 ;;
esac
include_existing="${INCLUDE_EXISTING:-}"
retry_failed="${RETRY_FAILED:-}"
if [[ "$SCRIPT" == queueFederatedBannerMirrors ]]; then
  for flag in "$include_existing" "$retry_failed"; do
    [[ -z "$flag" || "$flag" == true || "$flag" == false ]] || { echo '::error::include_existing and retry_failed must be true or false'; exit 1; }
  done
  include_existing="${include_existing:-false}"
  retry_failed="${retry_failed:-false}"
else
  [[ -z "$include_existing" && -z "$retry_failed" ]] || { echo '::error::include_existing/retry_failed apply to queueFederatedBannerMirrors only'; exit 1; }
fi
# The options a write must share with its reviewed dry run (banner recovery only).
options_json=$(jq -nc --arg script "$SCRIPT" --arg inc "$include_existing" --arg retry "$retry_failed" \
  'if $script == "queueFederatedBannerMirrors" then {includeExisting:($inc == "true"),retryFailed:($retry == "true")} else {} end')
repair_depth="${REPAIR_DEPTH:-}"
if [[ -n "$repair_depth" ]]; then
  [[ "$SCRIPT" == repairInstagramReelPosters && "$repair_depth" =~ ^[1-9][0-9]{0,3}$ && "$repair_depth" -le 1000 ]] || { echo '::error::repair_depth applies to repairInstagramReelPosters only, 1..1000'; exit 1; }
fi

case "$DRY_RUN" in
  true) ;;
  false)
    [[ "${CONFIRM_WRITE:-}" == "$SCRIPT" ]] || { echo "::error::A write run requires confirm_write=$SCRIPT"; exit 1; }
    jq -e --arg sha "$DEPLOY_SHA" --arg digest "$EXPECTED_IMAGE_DIGEST" --arg script "$SCRIPT" \
      --argjson options "$options_json" \
      '.script == $script and .sourceSha == $sha and .imageDigest == $digest and .dryRun == true and (.exitCode == 0 or .exitCode == 75)
       and (if $script == "queueFederatedBannerMirrors" then .options == $options else true end)' \
      reviewed-preview/instagram-one-shot-report.json >/dev/null \
      || { echo '::error::The reviewed preview is not a successful dry run of this script, with these options, on this source and image'; exit 1; }
    ;;
  *) echo '::error::dry_run must be exactly true or false'; exit 1 ;;
esac

# The deployment marker is written only after a successful backend rollout, so
# this runs the code that is live — and that was reviewed on main.
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
jq -e '.services[0] | .status == "ACTIVE" and .desiredCount > 0 and .runningCount == .desiredCount and .pendingCount == 0 and (.deployments | length == 1) and .deployments[0].rolloutState == "COMPLETED"' "$work_dir/service.json" >/dev/null \
  || { echo '::error::The backend service is not in a settled, single deployment'; exit 1; }
live_task_def=$(jq -r '.services[0].taskDefinition' "$work_dir/service.json")
aws ecs describe-task-definition --task-definition "$live_task_def" --query taskDefinition --output json > "$work_dir/taskdef.json"
# Exactly one backend container; never silently choose a sidecar.
jq -e '.containerDefinitions | length == 1' "$work_dir/taskdef.json" >/dev/null
container=$(jq -r '.containerDefinitions[0].name' "$work_dir/taskdef.json")
image=$(jq -r '.containerDefinitions[0].image' "$work_dir/taskdef.json")
[[ "$image" == "237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/mention@$EXPECTED_IMAGE_DIGEST" ]] || { echo '::error::Live image differs from the reviewed immutable digest'; exit 1; }
aws ecr batch-get-image --repository-name oxy/mention --image-ids "imageTag=$DEPLOY_SHA" --output json > "$work_dir/image.json"
jq -e --arg digest "$EXPECTED_IMAGE_DIGEST" '(.failures | length == 0) and (.images | length == 1) and .images[0].imageId.imageDigest == $digest' "$work_dir/image.json" >/dev/null \
  || { echo '::error::The image tagged with this source is not the reviewed digest'; exit 1; }
jq '{awsvpcConfiguration:.services[0].networkConfiguration.awsvpcConfiguration}' "$work_dir/service.json" > "$work_dir/network.json"
jq -e '.awsvpcConfiguration | (.subnets | length > 0) and (.securityGroups | length > 0) and (.assignPublicIp == "ENABLED" or .assignPublicIp == "DISABLED")' "$work_dir/network.json" >/dev/null

# A shell stays PID 1 so BusyBox timeout can stop the script at 3300 s (inside
# the 3600 s wait below); the explicit status keeps the shell from exec-ing.
# CONFIRM_ADMIN_MUTATION is set only on a confirmed write: withheld, a live mode
# that somehow reached the container is refused by the script itself.
jq -n --arg name "$container" --arg dry "$DRY_RUN" --arg script "$SCRIPT" --arg depth "$repair_depth" \
  --arg inc "$include_existing" --arg retry "$retry_failed" '
  {containerOverrides:[{name:$name,
    command: ["sh","-c","busybox timeout -s TERM -k 30 3300 bun \"$1\"; status=$?; exit \"$status\"","mention-instagram-one-shot",
              ("packages/backend/dist/src/scripts/" + $script + ".js")],
    environment: ([{name:"DRY_RUN",value:$dry},
                   {name:"CONFIRM_ADMIN_MUTATION",value:(if $dry == "false" then $script else "" end)}]
                  + (if $depth == "" then [] else [{name:"REPAIR_DEPTH",value:$depth}] end)
                  + (if $script == "queueFederatedBannerMirrors"
                     then [{name:"INCLUDE_EXISTING",value:$inc},{name:"RETRY_FAILED",value:$retry}] else [] end))}]}
' > "$work_dir/overrides.json"

# Re-read the live definition just before starting. Never update the service.
[[ "$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].taskDefinition' --output text)" == "$live_task_def" ]] || { echo '::error::The live task definition changed'; exit 1; }
aws ecs run-task --cluster "$CLUSTER" --task-definition "$live_task_def" --launch-type FARGATE \
  --network-configuration "file://$work_dir/network.json" --overrides "file://$work_dir/overrides.json" \
  --started-by gh-instagram-one-shot > "$work_dir/run.json"
jq -e '.failures | length == 0' "$work_dir/run.json" >/dev/null
task_arn=$(jq -er '.tasks[0].taskArn' "$work_dir/run.json")
task_stopped=false
log_group=$(jq -er '.containerDefinitions[0].logConfiguration.options["awslogs-group"]' "$work_dir/taskdef.json")
log_prefix=$(jq -er '.containerDefinitions[0].logConfiguration.options["awslogs-stream-prefix"]' "$work_dir/taskdef.json")
log_stream="$log_prefix/$container/${task_arn##*/}"
jq -n --arg sha "$DEPLOY_SHA" --arg digest "$EXPECTED_IMAGE_DIGEST" --arg script "$SCRIPT" --arg task "$task_arn" \
  --arg definition "$live_task_def" --arg group "$log_group" --arg stream "$log_stream" --argjson dry "$DRY_RUN" \
  '{script:$script,sourceSha:$sha,imageDigest:$digest,taskArn:$task,taskDefinition:$definition,dryRun:$dry,logGroup:$group,logStream:$stream}' \
  > instagram-one-shot-run.json
echo "Task: $task_arn"
echo "CloudWatch: $log_group / $log_stream"

for ((elapsed=0; elapsed<3600; elapsed+=15)); do
  aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task_arn" --output json > "$work_dir/result.json"
  if [[ "$(jq -r '.tasks[0].lastStatus' "$work_dir/result.json")" == STOPPED ]]; then task_stopped=true; break; fi
  sleep 15
done
[[ "$task_stopped" == true ]] || { echo '::error::The one-shot exceeded its wait bound'; exit 1; }
exit_code=$(jq -er --arg name "$container" '.tasks[0].containers[] | select(.name == $name) | .exitCode' "$work_dir/result.json")

# Read every page (the tally follows the per-candidate lines). CloudWatch may
# trail STOPPED briefly: retry collection, never infer completion.
complete_message="[$SCRIPT] complete"
candidate_message="[$SCRIPT] candidate"
for ((log_attempt=1; log_attempt<=5; log_attempt++)); do
  token=''
  : > "$work_dir/complete.jsonl"
  : > "$work_dir/candidates.jsonl"
  for ((page=0; page<10000; page++)); do
    args=(logs get-log-events --log-group-name "$log_group" --log-stream-name "$log_stream" --start-from-head --output json)
    if [[ -n "$token" ]]; then args+=(--next-token "$token"); fi
    if ! aws "${args[@]}" > "$work_dir/logs.json"; then
      : > "$work_dir/complete.jsonl"
      break
    fi
    jq -c --arg message "$complete_message" '.events[].message | fromjson? | select(.msg == $message)' "$work_dir/logs.json" >> "$work_dir/complete.jsonl"
    jq -c --arg message "$candidate_message" '.events[].message | fromjson? | select(.msg == $message) | {postId,sourceKey,slots}' "$work_dir/logs.json" >> "$work_dir/candidates.jsonl"
    next=$(jq -r '.nextForwardToken' "$work_dir/logs.json")
    [[ "$next" == "$token" ]] && break
    token="$next"
  done
  [[ "$page" -lt 10000 ]] || { echo '::error::Log paging limit reached; the result is incomplete'; exit 1; }
  [[ -s "$work_dir/complete.jsonl" ]] && break
  if [[ "$log_attempt" -lt 5 ]]; then sleep 2; fi
done

# Counts and public post ids / source keys only — never raw logs or inherited secrets.
jq -s -e --arg sha "$DEPLOY_SHA" --arg digest "$EXPECTED_IMAGE_DIGEST" --arg script "$SCRIPT" --argjson dry "$DRY_RUN" \
  --argjson code "$exit_code" --arg fields "$report_fields" --slurpfile candidates "$work_dir/candidates.jsonl" \
  --argjson options "$options_json" '
  if length != 1 then error("Expected exactly one completion line") else .[0] end
  | if .dryRun != $dry then error("The task reported a different execution mode") else . end
  | if ($options | has("includeExisting")) and ({includeExisting, retryFailed} != $options)
    then error("The task reported different options") else . end
  | . as $line
  | ($fields | split(",")) as $names
  | {script:$script,sourceSha:$sha,imageDigest:$digest,dryRun:$dry,exitCode:$code,
     report:(reduce $names[] as $n ({}; .[$n] = $line[$n])),
     options:$options,
     unvalidated:($line.unvalidated // []),
     candidates:($candidates | .[0:1000])}
  | if ([.report[] | (type == "number" and . >= 0 and floor == .)] | all) then . else error("Invalid summary counts") end
' "$work_dir/complete.jsonl" > "$work_dir/report.json" || {
  if [[ "$exit_code" == 143 ]]; then
    echo "::error::$SCRIPT was stopped at its 3300 s bound before its summary. Every write it made is committed and both scripts are idempotent: re-run to continue. Read the log: $log_group / $log_stream"
  else
    echo "::error::No valid [$SCRIPT] complete line (exit code $exit_code). Read the log: $log_group / $log_stream"
  fi
  exit 1
}
mv "$work_dir/report.json" instagram-one-shot-report.json
cat instagram-one-shot-report.json

verdict=''
case "$exit_code" in
  0) verdict='COMPLETE' ;;
  75) verdict='FINISHED WITH WORK LEFT — re-run later (not a failure)' ;;
  *) verdict="FAILED (exit $exit_code)" ;;
esac
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### $SCRIPT: $verdict"
    echo ""
    echo "Mode: \`dryRun=$DRY_RUN\`. Full log: CloudWatch \`$log_group\` / \`$log_stream\`."
    echo '```json'
    jq '{script,dryRun,exitCode,options,report,unvalidated,candidates:(.candidates | length)}' instagram-one-shot-report.json
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
fi
case "$exit_code" in
  0) ;;
  75) echo "::warning::$SCRIPT finished with work left over; every write it made is committed. Re-run later." ;;
  *) echo "::error::$SCRIPT failed with exit code $exit_code"; exit 1 ;;
esac
