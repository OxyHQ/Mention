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
  }
}

if (failures.length > 0) {
  console.error("GitHub Actions YAML validation failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Validated ${workflowNames.length} GitHub Actions workflow file(s).`);
