#!/usr/bin/env bash
# Never retain arbitrary application messages, task environments, or secret references.
set -euo pipefail
result=$1 definition=$2 task=$3
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
container=$(jq -er '.containerDefinitions[0].name' "$definition")
group=$(jq -er '.containerDefinitions[0].logConfiguration.options["awslogs-group"]' "$definition")
prefix=$(jq -er '.containerDefinitions[0].logConfiguration.options["awslogs-stream-prefix"]' "$definition")
for ((attempt=1; attempt<=5; attempt++)); do
  terminal_observed=false
  : > "$scratch/classified.jsonl"
  : > "$scratch/activity.jsonl"
  token=''
  logs_complete=false
  for ((page=0; page<10000; page++)); do
    args=(logs get-log-events --log-group-name "$group" --log-stream-name "$prefix/$container/${task##*/}" --start-from-head --output json)
    if [[ -n "$token" ]]; then args+=(--next-token "$token"); fi
    if ! aws "${args[@]}" > "$scratch/page.json"; then break; fi
    if jq -e '[.events[].message | fromjson? | objects | .msg? | strings | select(endswith("] complete") or endswith("] failed"))] | length > 0' "$scratch/page.json" >/dev/null; then terminal_observed=true; fi
    jq -c '.events[].message | fromjson? | select(type == "object") | select(.level == "error" or .level == 50 or (.msg // "" | strings | endswith("] failed"))) |
      {category:(if ((.error // .err // {}) | tostring | test("401|403|Unauthorized|Forbidden|authentication|credential";"i")) then "upstream_authentication"
        elif ((.error // .err // {}) | tostring | test("ZodError|invalid_type|invalid_union|validation";"i")) then "response_validation"
        elif ((.error // .err // {}) | tostring | test("ECONN|ETIMEDOUT|fetch failed|network|timeout";"i")) then "network_or_timeout"
        elif ((.error // .err // {}) | tostring | test("postgres|relation .* does not exist|SQL|database";"i")) then "database"
        else "application_error" end),
       httpStatus:([.. | objects | (.statusCode // .status // empty) | select(type == "number" and . >= 400 and . <= 599 and floor == .)] | unique),
       validationIssues:([., ([.error, .err][] | objects | .message? | strings | fromjson?)] | [.. | objects | select((.code? | type) == "string" and (.path? | type) == "array") | {code:(.code | select(. == "invalid_type" or . == "invalid_union" or . == "invalid_value" or . == "too_small" or . == "too_big" or . == "custom")),path:[.path[] | if type == "number" then . elif . == "identities" or . == "externalIdentities" or . == "actorUri" or . == "canonicalAcct" or . == "userId" or . == "network" or . == "protocol" or . == "transportAcct" or . == "sourceUserId" or . == "redirectedUserIds" or . == "identifier" then . else "other" end]}] | unique),
       stage:(if .msg == "[reconcileMetaIdentityAndCrossposts] failed" then "reconciliation" else "runtime" end)}' "$scratch/page.json" >> "$scratch/classified.jsonl"
    jq -c '
      def safe_count: type == "number" and . >= 0 and . <= 9007199254740991 and floor == .;
      def counters: {actorsExamined,actorsChanged,postsChanged,authorshipConflicts,mutesPreserved,clustersDissolved,postsExamined,postClustersCreated};
      .events[].message | fromjson? | objects |
      if .msg == "[reconcileMetaIdentityAndCrossposts] progress" then
        select((.phase == "actors" or .phase == "posts") and (.dryRun | type == "boolean") and (.batchesCompleted | safe_count)) |
        {kind:"progress",phase,dryRun,batchesCompleted,counts:(counters | with_entries(select(.value | safe_count)))}
      elif .msg == "[reconcileMetaIdentityAndCrossposts] complete" then
        {kind:"complete",valid:((.dryRun | type == "boolean") and (counters | [.[] | safe_count] | all) and
          (.refused | type == "object" and ([.[] | safe_count] | all) and ([.[]] | add // 0 | safe_count))),
         summary:{dryRun:(.dryRun | if type == "boolean" then . else null end),counts:(counters | with_entries(select(.value | safe_count))),
          refusedTotal:(.refused | if type == "object" then ([.[] | select(safe_count)] | add // 0) else null end)}}
      else empty end' "$scratch/page.json" >> "$scratch/activity.jsonl"
    next=$(jq -er '.nextForwardToken' "$scratch/page.json")
    if [[ "$next" == "$token" ]]; then logs_complete=true; break; fi
    token=$next
  done
  if [[ "$logs_complete" == true && "$terminal_observed" == true ]]; then break; fi
  if (( attempt < 5 )); then sleep 2; fi
done
jq -n --slurpfile result "$result" --slurpfile failures "$scratch/classified.jsonl" --slurpfile activity "$scratch/activity.jsonl" --arg container "$container" --arg task "$task" --argjson complete "$logs_complete" --argjson terminal "$terminal_observed" '
  [$activity[] | select(.kind == "complete")] as $summaries |
  (if ($summaries | length) == 0 then "absent"
   elif ($summaries | all(.valid)) | not then "invalid"
   elif ($summaries | map(.summary) | unique | length) != 1 then "ambiguous"
   else "valid" end) as $summary_status |
  {taskArn:$task,logsComplete:$complete,terminalEventObserved:$terminal,
   taskStatus:($result[0].tasks[0].lastStatus | if . == "RUNNING" or . == "PENDING" or . == "STOPPED" then . else "UNKNOWN" end),
   recoveryComplete:($result[0].tasks[0].lastStatus == "STOPPED" and $complete and $terminal and ($summary_status == "absent" or $summary_status == "valid")),
   taskStopped:($result[0].tasks[0].lastStatus == "STOPPED"),
   exitCode:([$result[0].tasks[0].containers[] | select(.name == $container) | .exitCode][0] // null),
   failureCategories:($failures | unique),summaryStatus:$summary_status,
   completeSummary:(if $summary_status == "valid" then $summaries[0].summary else null end),
   latestProgress:([$activity[] | select(.kind == "progress") | del(.kind)] | group_by(.phase) | map(max_by(.batchesCompleted)))}' > reconciliation-diagnostics.json
cat reconciliation-diagnostics.json
