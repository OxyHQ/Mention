#!/usr/bin/env bash
# Read one exact request correlation ID; never execute a task or print raw events.
set -euo pipefail
: "${REQUEST_INSPECTION:?}" "${EXPECTED_IMAGE_DIGEST:?}" "${CLUSTER:?}" "${SERVICE:?}"
[[ "$EXPECTED_IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
printf '%s' "$REQUEST_INSPECTION" > "$scratch/selector.json"
jq -e 'keys == ["endTime","requestId","sourceSha","startTime"] and (.requestId | test("^[a-zA-Z0-9_.:-]{8,128}$")) and (.sourceSha | test("^[0-9a-f]{40}$")) and ([.startTime,.endTime] | all(test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")))' "$scratch/selector.json" >/dev/null
request=$(jq -er '.requestId' "$scratch/selector.json")
source_sha=$(jq -er '.sourceSha' "$scratch/selector.json")
start=$(jq -er '.startTime | fromdateiso8601' "$scratch/selector.json")
end=$(jq -er '.endTime | fromdateiso8601' "$scratch/selector.json")
(( end > start && end - start <= 300 && end <= $(date +%s) )) || exit 1
aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --output json > "$scratch/service.json"
jq -e '(.failures | length == 0) and (.services | length == 1) and (.services[0] | .status == "ACTIVE" and .desiredCount > 0 and .runningCount == .desiredCount and .pendingCount == 0 and (.deployments | length == 1) and .deployments[0].rolloutState == "COMPLETED")' "$scratch/service.json" >/dev/null
definition=$(jq -er '.services[0].taskDefinition' "$scratch/service.json")
aws ecs describe-task-definition --task-definition "$definition" --query taskDefinition --output json > "$scratch/definition.json"
jq -e --arg image "237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/mention@$EXPECTED_IMAGE_DIGEST" '.containerDefinitions | length == 1 and .[0].image == $image' "$scratch/definition.json" >/dev/null
aws ecr batch-get-image --repository-name oxy/mention --image-ids "imageTag=$source_sha" --output json > "$scratch/image.json"
jq -e --arg digest "$EXPECTED_IMAGE_DIGEST" '(.failures | length == 0) and (.images | length == 1 and .[0].imageId.imageDigest == $digest)' "$scratch/image.json" >/dev/null
aws ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" --desired-status RUNNING --output json > "$scratch/tasks.json"
mapfile -t tasks < <(jq -er '.taskArns[]' "$scratch/tasks.json")
(( ${#tasks[@]} > 0 && ${#tasks[@]} <= 100 )) || exit 1
aws ecs describe-tasks --cluster "$CLUSTER" --tasks "${tasks[@]}" --output json > "$scratch/result.json"
jq -e --arg definition "$definition" --arg digest "$EXPECTED_IMAGE_DIGEST" --argjson expected "${#tasks[@]}" '(.failures | length == 0) and (.tasks | length == $expected and all(.taskDefinitionArn == $definition and .lastStatus == "RUNNING" and (.containers | length == 1 and all(.imageDigest == $digest and .lastStatus == "RUNNING"))))' "$scratch/result.json" >/dev/null
[[ "$(jq '.services[0].desiredCount' "$scratch/service.json")" == "${#tasks[@]}" ]] || exit 1
container=$(jq -er '.containerDefinitions[0].name' "$scratch/definition.json")
group=$(jq -er '.containerDefinitions[0].logConfiguration.options["awslogs-group"]' "$scratch/definition.json")
prefix=$(jq -er '.containerDefinitions[0].logConfiguration.options["awslogs-stream-prefix"]' "$scratch/definition.json")
# Only repository-owned module names can leave the log boundary.
git ls-files packages/backend/src | jq -Rs 'split("\n") | map(select(endswith(".ts")) | sub("^packages/backend/";"") | sub("\\.ts$";".js"))' > "$scratch/modules.json"
: > "$scratch/matches.jsonl"
for task in "${tasks[@]}"; do
  token=''
  for ((page=0; page<10000; page++)); do
    args=(logs get-log-events --log-group-name "$group" --log-stream-name "$prefix/$container/${task##*/}" --start-time "$((start * 1000))" --end-time "$((end * 1000))" --start-from-head --output json)
    if [[ -n "$token" ]]; then args+=(--next-token "$token"); fi
    aws "${args[@]}" > "$scratch/page.json"
    jq -c --arg request "$request" --slurpfile modules "$scratch/modules.json" '
      .events[] | .timestamp as $timestamp | .message | fromjson? | objects | select(.requestId == $request or .msg == "Unhandled error in request handler") |
      {timestamp:$timestamp,requestCorrelated:(.requestId == $request),route:(if .route == "/federation/resolve" or .routeTemplate == "/federation/resolve" then "/federation/resolve" elif .route == "/unmatched" or .routeTemplate == "/unmatched" then "/unmatched" else "unrecorded" end),
       category:(if ([.error,.err] | tostring | test("WRONGTYPE|NOSCRIPT|READONLY|(^|[^A-Z])OOM([^A-Z]|$)|not an integer|Error running script|ERR.*script";"i")) then "redis_operation"
         elif ([.error,.err] | tostring | test("Cannot read propert|Cannot destructure|undefined is not|null is not";"i")) then "invalid_object_access"
         elif ([.error,.err] | tostring | test("ZodError|invalid_type|invalid_union";"i")) then "response_validation"
         elif ([.error,.err] | tostring | test("postgres|relation .* does not exist|SQL|database";"i")) then "database"
         elif ([.error,.err] | tostring | test("ECONN|ETIMEDOUT|fetch failed|network|timeout";"i")) then "network_or_timeout"
         elif ([.error,.err] | tostring | test("401|403|Unauthorized|Forbidden";"i")) then "upstream_authentication"
         else "unclassified" end),
       counts:({oxyCallCount,failedOxyCallCount,queryCount,failedQueryCount} | with_entries(select(.value | type == "number" and . >= 0 and floor == .))),
       redisFailures:([.error,.err] | tostring | . as $detail | [
         (if $detail | test("WRONGTYPE") then "WRONGTYPE" else empty end),
         (if $detail | test("NOSCRIPT") then "NOSCRIPT" else empty end),
         (if $detail | test("READONLY") then "READONLY" else empty end),
         (if $detail | test("(^|[^A-Z])OOM([^A-Z]|$)") then "OOM" else empty end),
         (if $detail | test("not an integer";"i") then "NONINTEGER" else empty end),
         (if $detail | test("Error running script|ERR.*script";"i") then "SCRIPT_FAILURE" else empty end)]),
       status:([.. | objects | (.statusCode // .status // empty) | numbers | select(. >= 400 and . <= 599)] | unique),
       names:([(.. | objects | .name? | strings), ((.stack? // "") | strings | split(":")[0])] | map(select(. == "Error" or . == "TypeError" or . == "RangeError" or . == "ReferenceError" or . == "ZodError" or . == "PostgresError" or . == "AxiosError")) | unique),
       codes:([.. | objects | .code? | strings | select(. == "23505" or . == "23503" or . == "23502" or . == "42P01" or . == "42703" or . == "22P02" or . == "57014" or . == "53300" or . == "ECONNREFUSED" or . == "ETIMEDOUT" or . == "ECONNRESET" or . == "ERR_BAD_REQUEST" or . == "ERR_BAD_RESPONSE")] | unique),
       modules:([.. | objects | .stack? | strings | . as $stack | $modules[0][] | . as $owned_module | select($stack | contains($owned_module))] | unique)}' "$scratch/page.json" >> "$scratch/matches.jsonl"
    next=$(jq -er '.nextForwardToken' "$scratch/page.json")
    if [[ "$next" == "$token" ]]; then break; fi
    token=$next
  done
  (( page < 10000 )) || exit 1
done
jq -n --slurpfile selector "$scratch/selector.json" --slurpfile matches "$scratch/matches.jsonl" --arg digest "$EXPECTED_IMAGE_DIGEST" '{operation:"inspect_request",readOnly:true,selector:$selector[0],imageDigest:$digest,matches:$matches}' > reconciliation-request.json
cat reconciliation-request.json
jq -e '.matches | length > 0' reconciliation-request.json >/dev/null
