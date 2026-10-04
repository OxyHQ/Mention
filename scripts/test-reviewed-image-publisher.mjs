import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { isReviewedImagePublisher } from "./reviewed-image-publisher.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const name = "publish-reviewed-images.yml";
const read = (file) => readFileSync(resolve(root, file));
const workflow = parseDocument(read(".github/workflows/" + name).toString()).toJS();
assert.equal(isReviewedImagePublisher(name, workflow, read), true);
assert.equal(isReviewedImagePublisher("deploy-aws.yml", workflow, read), false);
for (const file of [".github/workflows/" + name, ".github/scripts/publish-reviewed-image.py", ".github/scripts/reviewed-images.json", ".github/scripts/candidate-api-image.py", ".github/scripts/test-candidate-api-image.py"]) {
  assert.equal(isReviewedImagePublisher(name, workflow, (path) =>
    path === file ? Buffer.concat([read(path), Buffer.from("\n# unreviewed change")]) : read(path)), false);
}
for (const mutate of [
  (copy) => { copy.on.push = { branches: ["main"] }; },
  (copy) => { copy.on.workflow_dispatch.inputs.expected_source_sha.required = false; },
  (copy) => { Object.values(copy.jobs)[0]["runs-on"] = "ubuntu-latest"; },
  (copy) => { Object.values(copy.jobs)[0].if = "true"; },
  (copy) => { Object.values(copy.jobs)[0].env.EXPECTED_SOURCE_SHA = "main"; },
  (copy) => { Object.values(copy.jobs)[0].steps.push({ run: "aws ecs update-service" }); },
  (copy) => { Object.values(copy.jobs)[0].steps.push({ run: "aws ssm put-parameter" }); },
  (copy) => { Object.values(copy.jobs)[0].steps = Object.values(copy.jobs)[0].steps.filter((step) => !step.run?.includes(" guard --recipe ")); },
  (copy) => { copy.jobs["mention-api-recovery-candidate"].permissions["id-token"] = "write"; },
  (copy) => { copy.jobs["mention-api-recovery-candidate"].steps.find(step => step.id === "build").with.push = true; },
  (copy) => { copy.jobs["mention-api-recovery-candidate"].steps.push({run: "aws ecs update-service"}); },
  (copy) => { copy.jobs["mention-api-recovery-candidate"].if = "true"; },
  (copy) => { copy.jobs["mention-api-recovery-candidate"].steps.find(step => step.id === "build").with.outputs = "type=registry"; },
  (copy) => { copy.jobs.extra = structuredClone(copy.jobs.mention); },
  (copy) => { copy.on.workflow_dispatch.inputs.api_recovery_candidate.default = true; },
]) {
  const copy = structuredClone(workflow); mutate(copy);
  assert.equal(isReviewedImagePublisher(name, copy, read), false);
}
console.log("22 publisher classification controls PASS; original deployment classification preserved");
