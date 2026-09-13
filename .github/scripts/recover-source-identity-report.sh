#!/usr/bin/env bash
# Only inspect the exact historical task emitted by this protected workflow.
set -euo pipefail
: "${RECOVERY_RUN_ID:?}" "${GITHUB_REPOSITORY:?}" "${ACTOR:?}" "${EXPECTED_IMAGE_DIGEST:?}" "${CLUSTER:?}"
[[ "$RECOVERY_RUN_ID" =~ ^[0-9]+$ && "$EXPECTED_IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
gh api "repos/$GITHUB_REPOSITORY/actions/runs/$RECOVERY_RUN_ID" > "$scratch/run.json"
jq -e --arg actor "$ACTOR" '.head_branch == "main" and .event == "workflow_dispatch" and .status == "completed" and .actor.login == $actor and .triggering_actor.login == $actor and .path == ".github/workflows/run-source-identity-reconciliation.yml" and (.head_sha | test("^[0-9a-f]{40}$"))' "$scratch/run.json" >/dev/null
source_sha=$(jq -er '.head_sha' "$scratch/run.json")
gh run view "$RECOVERY_RUN_ID" --repo "$GITHUB_REPOSITORY" --log > "$scratch/job.log"
# This literal line comes from the launcher, which never prints application logs.
mapfile -t tasks < <(sed -nE 's/^reconcile[[:space:]]+Reconcile with the exact deployed image[[:space:]]+[0-9TZ:.+-]+ Reconciliation task: (arn:aws:ecs:us-west-2:237343248947:task\/oxy-cluster\/[0-9a-f]{32})$/\1/p' "$scratch/job.log" | sort -u)
[[ ${#tasks[@]} == 1 ]] || { echo '::error::Expected exactly one trusted task selector'; exit 1; }
task=${tasks[0]}
aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task" --output json > "$scratch/result.json"
jq -e --arg task "$task" '.failures | length == 0' "$scratch/result.json" >/dev/null
jq -e --arg task "$task" '.tasks | length == 1 and .[0].taskArn == $task and .[0].lastStatus == "STOPPED" and .[0].startedBy == "gh-source-identity-reconcile"' "$scratch/result.json" >/dev/null
definition=$(jq -er '.tasks[0].taskDefinitionArn' "$scratch/result.json")
aws ecs describe-task-definition --task-definition "$definition" --query taskDefinition --output json > "$scratch/definition.json"
jq -e --arg image "237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/mention@$EXPECTED_IMAGE_DIGEST" '.containerDefinitions | length == 1 and .[0].image == $image' "$scratch/definition.json" >/dev/null
aws ecr batch-get-image --repository-name oxy/mention --image-ids "imageTag=$source_sha" --output json > "$scratch/image.json"
jq -e --arg digest "$EXPECTED_IMAGE_DIGEST" '(.failures | length == 0) and (.images | length == 1 and .[0].imageId.imageDigest == $digest)' "$scratch/image.json" >/dev/null
jq -n --arg sha "$source_sha" --arg digest "$EXPECTED_IMAGE_DIGEST" --arg task "$task" --arg definition "$definition" --arg run "$RECOVERY_RUN_ID" '{operation:"recover_report",sourceSha:$sha,imageDigest:$digest,taskArn:$task,taskDefinition:$definition,recoveredRunId:$run,readOnly:true}' > reconciliation-run.json
bash "$(dirname "${BASH_SOURCE[0]}")/collect-source-identity-diagnostics.sh" "$scratch/result.json" "$scratch/definition.json" "$task"
jq -e '.logsComplete == true' reconciliation-diagnostics.json >/dev/null
