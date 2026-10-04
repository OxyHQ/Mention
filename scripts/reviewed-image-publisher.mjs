import { createHash } from "node:crypto";

// Reviewed ECR-only publication is not an ECS deployment. Keep this exception
// closed to all reviewed source inputs; changing any requires an explicit review
// and refreshed pins, not a filename-only exemption from deployment guards.
const reviewed = {
  ".github/workflows/publish-reviewed-images.yml": "a88bac8fd2672c42aae38197a25deaad27f3c93c46105e961a8e374bde00abe8",
  ".github/scripts/publish-reviewed-image.py": "4c20fa31ef8bcd5f18e8e894d6fd35157e7bcce1ef9392f70c21cdd6aa86f17e",
  ".github/scripts/reviewed-images.json": "2999dad8b1921ad29ad3b30dc2878f009682dbeea16dfe2b75d8b8aee878565a",
  ".github/scripts/candidate-api-image.py": "3382e0b6caa763c46125dbc9d1c8c1277f13a31add707311ca4ae3975498a83d",
  ".github/scripts/test-candidate-api-image.py": "fa20d911b2b8387f60c5384340a9b0d37f6296f1c59fdb7737205a5db64a334d"
};

export function isReviewedImagePublisher(name, workflow, read) {
  if (name !== "publish-reviewed-images.yml") return false;
  try {
    for (const [file, expected] of Object.entries(reviewed)) {
      if (createHash("sha256").update(read(file)).digest("hex") !== expected) return false;
    }
    if (Object.keys(workflow.on ?? {}).join() !== "workflow_dispatch" ||
        workflow.on.workflow_dispatch.inputs?.expected_source_sha?.required !== true) return false;
    if (Object.keys(workflow.jobs ?? {}).sort().join() !== "mention,mention-api-recovery-candidate,mention-mcp" ||
        workflow.on.workflow_dispatch.inputs?.api_recovery_candidate?.default !== false) return false;
    return Object.entries(workflow.jobs ?? {}).every(([name, job]) => {
      if (name === "mention-api-recovery-candidate") {
        const build = job.steps?.find((step) => step.id === "build");
        const text = JSON.stringify(job);
        return job["runs-on"] === "ubuntu-24.04-arm" &&
          JSON.stringify(job.permissions) === JSON.stringify({ contents: "read", actions: "read", "pull-requests": "read" }) &&
          job.if.includes("inputs.api_recovery_candidate == true") &&
          job.if.includes("github.ref != 'refs/heads/main'") &&
          job.if.includes("github.actor == 'NateIsern'") &&
          job.env?.EXPECTED_SOURCE_SHA === "${{ inputs.expected_source_sha }}" &&
          job.steps?.some((step) => step.run === "python3 -B .github/scripts/candidate-api-image.py") &&
          build?.with?.push === false && build.with.platforms === "linux/arm64" &&
          build.with.outputs === "type=oci,dest=${{ steps.guard.outputs.proof_path }}/image.tar" &&
          !/aws-actions|id-token|aws (?:ecs|ssm|ecr)|role-to-assume/i.test(text);
      }
      const guard = "python3 -B .github/scripts/publish-reviewed-image.py ";
      const runs = (job.steps ?? []).filter((step) => step.run).map((step) => step.run);
      return job["runs-on"] === "ubuntu-24.04-arm" &&
        job.if.includes("github.event_name == 'workflow_dispatch'") &&
        job.if.includes("github.ref == 'refs/heads/main'") &&
        job.if.includes("inputs.api_recovery_candidate != true") &&
        job.env?.EXPECTED_SOURCE_SHA === "${{ inputs.expected_source_sha }}" &&
        runs.length === 3 &&
        ["guard", "vacancy", "verify"].every((phase, i) =>
          runs[i].startsWith(guard + phase + " --recipe "));
    });
  } catch {
    return false;
  }
}
