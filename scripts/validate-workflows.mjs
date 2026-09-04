#!/usr/bin/env bun

import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowsDirectory = resolve(repositoryRoot, ".github/workflows");
const workflowNames = (await readdir(workflowsDirectory))
  .filter((name) => /\.ya?ml$/i.test(name))
  .sort();

const failures = [];
for (const workflowName of workflowNames) {
  const source = await readFile(resolve(workflowsDirectory, workflowName), "utf8");
  const document = parseDocument(source, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  for (const error of document.errors) {
    failures.push(`${workflowName}: ${error.message}`);
  }

  if (document.errors.length === 0) {
    const workflow = document.toJS();
    if (source.includes("configure-aws-credentials")) {
      for (const [jobName, job] of Object.entries(workflow?.jobs || {})) {
        if (job?.environment != null) {
          failures.push(
            `${workflowName}: AWS job ${jobName} must not attach a GitHub environment while the deploy-role trust only accepts the main ref subject`,
          );
        }
      }
      const currentMainGuardCount = source
        .split("require-current-main.sh")
        .length - 1;
      if (currentMainGuardCount < 2) {
        failures.push(
          `${workflowName}: AWS production workflows must verify current origin/main before build and execution`,
        );
      }
      if (source.includes("aws ecr describe-images")) {
        failures.push(
          `${workflowName}: deploy role lacks ecr:DescribeImages; consume the immutable build action digest instead`,
        );
      }
      if (source.includes("aws ecs stop-task")) {
        failures.push(
          `${workflowName}: deploy role lacks ecs:StopTask; workflow must not depend on it`,
        );
      }
      if (
        workflowName === "run-federated-text-backfill.yml" &&
        (!source.includes(
          '"busybox","timeout","-s","TERM","-k","30","3300"',
        ) ||
          !source.includes("EXPECTED_RUNTIME_COMMANDS: 'bun,busybox'"))
      ) {
        failures.push(
          `${workflowName}: backfill command must remain container-bounded and the image audit must verify BusyBox`,
        );
      }
    }
    if (workflow?.on?.workflow_run && workflowName.startsWith("deploy-")) {
      const currentMainGuardCount = source
        .split("require-current-main.sh")
        .length - 1;
      if (currentMainGuardCount < 2) {
        failures.push(
          `${workflowName}: production workflow_run releases must verify origin/main before both build and deploy`,
        );
      }
      if (
        source.includes("steps.changes.outputs.deploy") ||
        source.includes("git diff --quiet")
      ) {
        failures.push(
          `${workflowName}: production workflow_run releases must not skip artifacts from a single-commit path diff`,
        );
      }

      // deployment-scope.sh diffs the candidate against the `deployed/<target>`
      // marker and silently degrades to the single-commit diff when the marker
      // is absent, so the checkout must actually deliver the tag and history,
      // and a green rollout must move the marker forward.
      const jobs = Object.entries(workflow?.jobs || {});
      const stepRuns = (job) =>
        (job?.steps || []).map((step) =>
          typeof step?.run === "string" ? step.run : "",
        );

      const scopeJob = jobs.find(([, job]) =>
        stepRuns(job).some((run) => run.includes("deployment-scope.sh")),
      );
      if (!scopeJob) {
        failures.push(
          `${workflowName}: production workflow_run releases must resolve their scope through deployment-scope.sh`,
        );
      } else {
        const [scopeName, job] = scopeJob;
        const checkout = (job?.steps || []).find(
          (step) =>
            typeof step?.uses === "string" &&
            step.uses.startsWith("actions/checkout@"),
        );
        if (
          checkout?.with?.["fetch-depth"] !== 0 ||
          checkout?.with?.["fetch-tags"] !== true
        ) {
          failures.push(
            `${workflowName}: ${scopeName} must check out with fetch-depth: 0 and fetch-tags: true, otherwise the deployed/<target> marker is missing and the scope silently narrows to one commit`,
          );
        }
      }

      const recordJob = jobs.find(([, job]) =>
        stepRuns(job).some((run) => run.includes("record-deployment.sh")),
      );
      if (!recordJob) {
        failures.push(
          `${workflowName}: a successful rollout must move its deployed/<target> marker through record-deployment.sh`,
        );
      } else {
        const [recordName, job] = recordJob;
        if (job?.permissions?.contents !== "write") {
          failures.push(
            `${workflowName}: ${recordName} must request job-level contents: write to move the marker`,
          );
        }
        const needs = Array.isArray(job?.needs)
          ? job.needs
          : job?.needs
            ? [job.needs]
            : [];
        if (needs.length === 0) {
          failures.push(
            `${workflowName}: ${recordName} must depend on the deploy job so the marker only moves after a green rollout`,
          );
        }
        if (/\b(always|failure|cancelled)\s*\(/.test(String(job?.if ?? ""))) {
          failures.push(
            `${workflowName}: ${recordName} must not run on a failed or cancelled rollout; a marker moved past an undeployed change orphans it permanently`,
          );
        }
      }

      if (workflow?.permissions?.contents === "write") {
        failures.push(
          `${workflowName}: workflow-level contents: write would hand a push-capable token to the build job; scope it to the marker job instead`,
        );
      }

      if (
        workflowName === "deploy-aws.yml" ||
        workflowName === "deploy-mcp-aws.yml"
      ) {
        const buildIndex = source.indexOf("Build and push immutable");
        const auditIndex = source.indexOf("audit-runtime-image.sh");
        const productionChangesIndex = source.indexOf(
          "Verify current main before production changes",
        );
        if (
          buildIndex < 0 ||
          auditIndex < buildIndex ||
          productionChangesIndex < auditIndex
        ) {
          failures.push(
            `${workflowName}: final runtime image audit must run after the immutable build and before production changes`,
          );
        }
        for (const unsupportedElbSetting of [
          "HEALTH_CHECK_PATH:",
          "EXPECTED_PRE_ROLLOUT_HEALTH_CHECK_PATH:",
          "ENABLE_TARGET_STICKINESS:",
          "TARGET_STICKINESS_SECONDS:",
        ]) {
          if (source.includes(unsupportedElbSetting)) {
            failures.push(
              `${workflowName}: ${unsupportedElbSetting.slice(0, -1)} requires ELB permissions that the production deploy role does not have`,
            );
          }
        }
        if (
          workflowName === "deploy-mcp-aws.yml" &&
          (
            !source.includes("TASK_SECRET_OVERRIDES_JSON") ||
            !source.includes(
              "parameter/oxy/mention-mcp/MENTION_MCP_JWT_SECRET",
            )
          )
        ) {
          failures.push(
            `${workflowName}: the immutable MCP task definition must explicitly inject its JWT signing secret`,
          );
        }
        if (
          source.includes('secrets.OXY_SERVICE_API_KEY') ||
          source.includes('secrets.OXY_SERVICE_API_SECRET')
        ) {
          failures.push(
            `${workflowName}: Oxy owns the Mention service credential in SSM; a deploy must not overwrite it from GitHub secrets`,
          );
        }
        if (
          workflowName === "deploy-mcp-aws.yml" &&
          (
            !source.includes("parameter/oxy/mention/OXY_SERVICE_API_KEY") ||
            !source.includes("parameter/oxy/mention/OXY_SERVICE_API_SECRET")
          )
        ) {
          failures.push(
            `${workflowName}: backend and MCP must consume the same app-owned Mention service credential`,
          );
        }
        if (
          workflowName === "deploy-aws.yml" &&
          (
            !source.includes("TASK_SECRET_OVERRIDES_JSON") ||
            !source.includes(
              "parameter/oxy/mention/MENTION_MCP_JWT_SECRET",
            )
          )
        ) {
          failures.push(
            `${workflowName}: the immutable backend task definition must explicitly inject its MCP JWT verification secret`,
          );
        }
      }

      if (workflowName === "deploy-frontends.yml") {
        const buildIndex = source.indexOf("Build frontend");
        const staticValidationIndex = source.indexOf(
          "validate-frontend-static-output.mjs",
        );
        const productionChangesIndex = source.indexOf(
          "Verify current main before production changes",
        );
        if (
          buildIndex < 0 ||
          staticValidationIndex < buildIndex ||
          productionChangesIndex < staticValidationIndex
        ) {
          failures.push(
            `${workflowName}: static hosting contract validation must run after export and before production changes`,
          );
        }

        const productionSmokeIndex = source.indexOf("id: production_smoke");
        const apexSmokeIndex = source.indexOf(
          "Smoke test the apex after the backend rollout",
        );
        const rollbackIndex = source.indexOf(
          "Roll back Cloudflare Pages after a failed production smoke",
        );
        if (
          productionSmokeIndex < 0 ||
          apexSmokeIndex < productionSmokeIndex ||
          rollbackIndex < apexSmokeIndex
        ) {
          failures.push(
            `${workflowName}: exact Pages smoke, apex convergence and rollback must remain separate and ordered`,
          );
        }
        if (
          !source.includes("steps.production_smoke.outcome == 'failure'")
        ) {
          failures.push(
            `${workflowName}: an apex/backend race must not roll back a validated Pages deployment`,
          );
        }
      }
    }

    // The frontend coverage policy is a STEP inside the test matrix, so deleting
    // the step deletes the gate silently: the suite stays green and no check
    // reports itself missing. Asserting it from a different job — `quality`,
    // which always runs — is what makes the deletion loud. Ordering matters as
    // well, because the policy reads the report `test:coverage` writes: a step
    // placed above the suite would measure the previous run's artefacts, or
    // nothing at all.
    if (workflowName === "ci.yml") {
      const suiteIndex = source.indexOf("Run complete package test suite");
      const policyIndex = source.indexOf("Enforce the frontend coverage policy");
      if (policyIndex < 0) {
        failures.push(
          `${workflowName}: the frontend test leg must run \`coverage:check\` — without it the critical-path floor and the no-regression ratchet enforce nothing`,
        );
      } else if (suiteIndex < 0 || policyIndex < suiteIndex) {
        failures.push(
          `${workflowName}: the coverage policy step must come after the suite that writes the report it reads`,
        );
      } else if (!source.includes("COVERAGE_POLICY_BASE")) {
        failures.push(
          `${workflowName}: the coverage policy step must be given a base revision, or a pull request can lower the recorded baseline in the same commit that removed the tests`,
        );
      }
    }
  }
}

if (failures.length > 0) {
  console.error("GitHub Actions YAML validation failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Validated ${workflowNames.length} GitHub Actions workflow file(s).`);
