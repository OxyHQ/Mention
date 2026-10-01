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

/** A JSON array of names, or nothing at all — a malformed value is the YAML gate's business, not this one's. */
function parseJsonNames(value) {
  const parsed = parseJsonValue(value);
  return Array.isArray(parsed) ? parsed.filter((name) => typeof name === "string") : [];
}

/** A JSON object of name → SSM ARN, or nothing at all. */
function parseJsonObject(value) {
  const parsed = parseJsonValue(value);
  return parsed != null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function parseJsonValue(value) {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

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
    /**
     * A secret may not be REMOVED and OVERRIDDEN in the same deploy step.
     *
     * `deploy-ecs-image.sh` already refuses this, and refuses it for a good
     * reason — the render filters the running revision's secrets by name and
     * THEN concatenates the overrides, so a name in both lists has an outcome
     * that depends on the order of two operations on secrets, which is not a
     * thing to leave to reading order. But it refuses at DEPLOY time, after the
     * image is built and pushed, which means the contradiction is invisible
     * until production stops moving.
     *
     * It did. `deploy-mcp-aws.yml` named the Oxy pair in both lists, and every
     * `mention-mcp` deploy died before its rollout for a day — long enough that
     * the service was still serving an image from before the code that the
     * failed deploys were carrying. Nothing in CI said a word, because both
     * declarations are individually valid YAML and individually correct.
     *
     * So the same rule runs here, where it costs a pull request a red check
     * instead of costing production a day.
     */
    for (const [jobName, job] of Object.entries(workflow?.jobs || {})) {
      for (const step of job?.steps || []) {
        const env = step?.env;
        if (env == null) continue;
        const removals = [
          ...String(env.TASK_SECRET_REMOVALS ?? "").split(/\s+/),
          ...parseJsonNames(env.TASK_SECRET_REMOVALS_JSON),
        ].filter(Boolean);
        const overridden = Object.keys(parseJsonObject(env.TASK_SECRET_OVERRIDES_JSON));
        const both = removals.filter((name) => overridden.includes(name));
        for (const name of both) {
          failures.push(
            `${workflowName}: ${jobName} declares ${name} in both TASK_SECRET_OVERRIDES_JSON and the removals — ` +
              "`deploy-ecs-image.sh` refuses that at deploy time, so it fails every release rather than one review",
          );
        }
      }
    }
    if (source.includes("configure-aws-credentials")) {
      for (const [jobName, job] of Object.entries(workflow?.jobs || {})) {
        if (job?.environment != null) {
          failures.push(
            `${workflowName}: AWS job ${jobName} must not attach a GitHub environment while the deploy-role trust only accepts the main ref subject`,
          );
        }
      }
      // The merge-queue image build is the one AWS workflow that is not a
      // production release: it runs on the queue's temporary ref, where there
      // is no current main to verify, and its role can only push images. So it
      // is held to what makes that safe instead: `merge_group` is its only
      // trigger (never pull_request or push, so no pull request's code and no
      // fork reaches AWS), and it assumes the push-only queue role, never the
      // deploy role.
      const triggers =
        typeof workflow?.on === "string" ? [workflow.on] : Object.keys(workflow?.on || {});
      const queueImageBuild = triggers.length === 1 && triggers[0] === "merge_group";
      if (queueImageBuild) {
        if (
          !source.includes("role/oxy-github-queue-image-mention") ||
          source.includes("role/oxy-github-deploy")
        ) {
          failures.push(
            `${workflowName}: a merge_group-only AWS workflow must assume oxy-github-queue-image-mention and never the deploy role`,
          );
        }
      } else {
        const currentMainGuardCount = source
          .split("require-current-main.sh")
          .length - 1;
        if (currentMainGuardCount < 2) {
          failures.push(
            `${workflowName}: AWS production workflows must verify current origin/main before build and execution`,
          );
        }
        if (source.includes("role/oxy-github-queue-image-mention")) {
          failures.push(
            `${workflowName}: only a merge_group-only workflow may assume the merge-queue image role`,
          );
        }
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

      /**
       * The push trigger releases a commit WITHOUT a CI run on main, on the
       * strength of its merge_group run. That is only sound while the push path
       * cannot skip the check that says so, so the shape is asserted: the
       * provenance decision runs in the scope job, before the scope it gates,
       * with the read access it needs — and the marker only moves after a
       * rollout that actually happened, not after a job that ended green at a
       * stale-release guard.
       */
      if (workflow?.on?.push) {
        const branches = workflow.on.push?.branches ?? [];
        if (branches.length !== 1 || branches[0] !== "main") {
          failures.push(`${workflowName}: a production push trigger must be restricted to main alone`);
        }
        const scopeRuns = scopeJob ? stepRuns(scopeJob[1]) : [];
        const provenanceIndex = scopeRuns.findIndex((run) => run.includes("release-provenance.sh"));
        const scopeIndex = scopeRuns.findIndex((run) => run.includes("deployment-scope.sh"));
        if (provenanceIndex < 0 || scopeIndex < provenanceIndex) {
          failures.push(
            `${workflowName}: a push-triggered release must decide its path through release-provenance.sh before its scope — otherwise a commit no CI run ever passed reaches production`,
          );
        }
        if (scopeJob && scopeJob[1]?.permissions?.actions !== "read") {
          failures.push(`${workflowName}: ${scopeJob[0]} needs job-level actions: read to verify the merge_group CI run`);
        }
        if (workflow?.concurrency != null) {
          failures.push(
            `${workflowName}: with two triggers the release lane must be a JOB-level concurrency group on the deploy job; a workflow-level one lets a no-op run displace a pending release`,
          );
        }
        if (recordJob && !String(recordJob[1]?.if ?? "").includes("outputs.released == 'true'")) {
          failures.push(
            `${workflowName}: ${recordJob[0]} must require the deploy job's \`released\` output — a deploy that stopped at a stale guard ends green having shipped nothing`,
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
        /**
         * Neither deploy may inject the Oxy service credential — the inverse of
         * the rule that stood here, and true for the same reason the old one was.
         *
         * That rule required the MCP workflow to name
         * `parameter/oxy/mention/OXY_SERVICE_API_KEY`, so that backend and MCP
         * spoke to Oxy as the SAME application rather than drifting onto two
         * identities. They still do: both attest their own ECS task role (oxy
         * ADR 0026) and both roles are bound to application Mention, with
         * `oxy-mention-task` and `oxy-mention-mcp-task` each carrying the same
         * nine scopes. The shared identity survived; the shared SECRET is what
         * went.
         *
         * Stated as an absence because that is the failure mode now. A revision
         * is rendered from the RUNNING one, so re-adding the injection here does
         * not merely duplicate a parameter — it puts the pair back on every
         * future revision of a service that has stopped reading it, silently,
         * and the only sign is an SSM parameter nobody can delete.
         */
        if (
          source.includes("parameter/oxy/mention/OXY_SERVICE_API_KEY") ||
          source.includes("parameter/oxy/mention/OXY_SERVICE_API_SECRET")
        ) {
          failures.push(
            `${workflowName}: neither deploy may inject the Oxy service credential — both services attest their own task role, and a render carries an injected secret onto every later revision`,
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
          "Roll back the shell Worker after a failed production smoke",
        );
        if (
          productionSmokeIndex < 0 ||
          apexSmokeIndex < productionSmokeIndex ||
          rollbackIndex < apexSmokeIndex
        ) {
          failures.push(
            `${workflowName}: exact deployment smoke, apex convergence and rollback must remain separate and ordered`,
          );
        }
        if (
          !source.includes("steps.production_smoke.outcome == 'failure'")
        ) {
          failures.push(
            `${workflowName}: an apex/backend race must not roll back a validated deployment`,
          );
        }

        // The web shell is a WORKER. A Pages project always serves
        // `<project>.pages.dev` with no way to switch it off, and for Mention that
        // duplicate was load bearing — it was the origin the apex proxied to, and
        // it served the app to anyone who found the name. Promoting to Pages again
        // would restore exactly that, so the shape is asserted rather than trusted
        // to stay put. The preview leg is still Pages on purpose (it is the release
        // gate's candidate origin) and is matched narrowly enough not to trip it.
        if (source.includes("pages deploy") && source.includes("--branch=main")) {
          failures.push(
            `${workflowName}: the web shell must be promoted to the Worker, not to a Cloudflare Pages production branch`,
          );
        }
        if (!source.includes("Promote the validated assets to the shell Worker")) {
          failures.push(
            `${workflowName}: the production promotion step must deploy the shell Worker`,
          );
        }
        // Without `--secrets-file` the upload carries no access key, and a Worker
        // without one answers 503 to the backend — the whole web plane down, with
        // the deploy reporting success.
        //
        // Matched adjacent to `deploy` rather than on its own, because the flag is
        // named in the comment above that step too: a bare substring check passed
        // this file with the flag deleted from the command and only the prose left.
        if (!source.includes("deploy --secrets-file")) {
          failures.push(
            `${workflowName}: the Worker deploy must upload the shell access key with the code, or a deployed version can exist without it`,
          );
        }
        // THE CHECK THAT MEASURES THE POINT OF THE MIGRATION. Every other check
        // here authenticates, so none of them would notice the Worker serving the
        // app to anyone — which is what a lost `run_worker_first`, a dropped
        // access gate or a re-enabled `workers_dev` would each cause, silently.
        if (
          !source.includes("The shell Worker refuses an unauthenticated caller")
        ) {
          failures.push(
            `${workflowName}: the deploy must assert that shell.mention.earth answers 403 without a key — nothing else would catch the app becoming publicly readable again`,
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
      /**
       * The backend suite is sharded, so the two whole-suite judgements — the
       * coverage floors and the collection gate — live in ONE merge job. Deleting
       * that job, or its refusal of a missing shard, would leave three green
       * shards and nothing judging the suite they add up to.
       */
      if (workflow?.on?.merge_group == null) {
        failures.push(`${workflowName}: must run on merge_group, or the merge queue has no CI to wait on`);
      }
      const mergeJob = workflow?.jobs?.["ci-complete"];
      const mergeRuns = (mergeJob?.steps || []).map((step) => (typeof step?.run === "string" ? step.run : ""));
      if (!mergeRuns.some((run) => run.includes("--merge-reports"))) {
        failures.push(`${workflowName}: CI complete must merge every shard's blob with vitest --merge-reports, which is where the coverage floors are enforced`);
      }
      if (!mergeRuns.some((run) => run.includes("check:suite-collection"))) {
        failures.push(`${workflowName}: CI complete must run the collection gate over the merged report`);
      }
      if (!mergeRuns.some((run) => run.includes("BACKEND_SHARDS"))) {
        failures.push(`${workflowName}: CI complete must refuse a missing or extra shard before merging`);
      }
      const shardList = workflow?.jobs?.["backend-test"]?.strategy?.matrix?.shard;
      if (!Array.isArray(shardList) || String(mergeJob?.env?.BACKEND_SHARDS) !== String(shardList.length)) {
        failures.push(`${workflowName}: CI complete's BACKEND_SHARDS must equal the length of backend-test's shard list`);
      }
      const completeNeeds = workflow?.jobs?.["ci-complete"]?.needs ?? [];
      for (const job of ["provenance", "quality", "lockfile", "tests", "backend-test", "e2e"]) {
        if (!completeNeeds.includes(job)) {
          failures.push(`${workflowName}: CI complete must need ${job}`);
        }
      }
      /**
       * A queue-verified push skips the heavy jobs. That is only sound while
       * the answer comes from the shared predicate, on push alone, and while a
       * heavy job is skipped for no other reason: its condition must be the
       * provenance answer and nothing looser.
       */
      const provenance = workflow?.jobs?.provenance;
      const provenanceRuns = (provenance?.steps || []).map((step) => (typeof step?.run === "string" ? step.run : ""));
      if (!provenanceRuns.some((run) => run.includes("merge-queue-verified.sh"))) {
        failures.push(`${workflowName}: the provenance job must answer through merge-queue-verified.sh, the predicate the deploys share`);
      }
      if (String(provenance?.if ?? "") !== "github.event_name == 'push'") {
        failures.push(`${workflowName}: the provenance job must run on push alone`);
      }
      for (const job of ["quality", "lockfile", "tests", "backend-test", "e2e"]) {
        const condition = String(workflow?.jobs?.[job]?.if ?? "");
        if (condition !== "${{ !cancelled() && needs.provenance.outputs.verified != 'true' }}") {
          failures.push(`${workflowName}: ${job} may be skipped only on a queue-verified push; its if: must be exactly the provenance condition`);
        }
      }

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

/**
 * The configuration-only redeploy (deploy-backend-config.yml) re-runs the code
 * release's secret sync and task render on the running image. It carries COPIES
 * of those two deploy-aws.yml steps, because sharing them would mean one
 * workflow mixing the dispatch trigger with the workflow_run head SHA — the
 * flow CodeQL correctly reports as cache poisoning. A copy is only safe while it
 * IS a copy, so any difference fails here: a secret synced by one path and not
 * the other, or a binding one path renders and the other drops, is exactly the
 * drift that a config redeploy would then ship to production.
 *
 * And the redeploy itself must stay the shape that makes it safe: dispatch
 * only, main only, a required reason, github.sha checked out with no ref.
 */
{
  const readWorkflow = async (name) =>
    parseDocument(await readFile(resolve(workflowsDirectory, name), "utf8")).toJS();
  const release = await readWorkflow("deploy-aws.yml");
  const redeploy = await readWorkflow("deploy-backend-config.yml").catch(() => undefined);
  if (redeploy) {
    const name = "deploy-backend-config.yml";
    const triggers = Object.keys(redeploy.on ?? {});
    if (triggers.length !== 1 || triggers[0] !== "workflow_dispatch") {
      failures.push(`${name}: must be triggered by workflow_dispatch alone, never by an event that can name another commit`);
    }
    if (redeploy.on?.workflow_dispatch?.inputs?.reason?.required !== true) {
      failures.push(`${name}: must require a \`reason\` input`);
    }
    const inputNames = Object.keys(redeploy.on?.workflow_dispatch?.inputs ?? {});
    if (inputNames.some((input) => input !== "reason")) {
      failures.push(`${name}: must take no input but \`reason\`; a ref or SHA input would let a dispatch run code other than main's head`);
    }
    const jobs = Object.values(redeploy.jobs ?? {});
    for (const job of jobs) {
      if (!String(job?.if ?? "").includes("github.ref == 'refs/heads/main'")) {
        failures.push(`${name}: every job must be gated to github.ref == 'refs/heads/main'`);
      }
      for (const step of job?.steps ?? []) {
        if (typeof step?.uses === "string" && step.uses.startsWith("actions/checkout@") && step.with?.ref !== undefined) {
          failures.push(`${name}: its checkout must take no \`ref\`; github.sha of main is the only code it may run`);
        }
        if (typeof step?.uses === "string" && /docker\/build-push-action|actions\/cache/.test(step.uses)) {
          failures.push(`${name}: must not build or use a cache; it redeploys the running image`);
        }
      }
    }
    const releaseSteps = release?.jobs?.deploy?.steps ?? [];
    const redeploySteps = jobs.flatMap((job) => job?.steps ?? []);
    const comparable = (step, ignoredEnv = []) => {
      if (!step) return undefined;
      const env = { ...(step.env ?? {}) };
      for (const key of ignoredEnv) delete env[key];
      return JSON.stringify({ id: step.id, env, run: step.run });
    };
    for (const [stepName, ignoredEnv] of [
      ["Sync GitHub secrets to SSM", []],
      ["Register immutable task definition and deploy", ["IMAGE_URI", "RUN_MIGRATIONS"]],
    ]) {
      const original = comparable(releaseSteps.find((step) => step?.name === stepName), ignoredEnv);
      const copy = comparable(redeploySteps.find((step) => step?.name === stepName), ignoredEnv);
      if (!original || !copy) {
        failures.push(`${name}: both workflows must have a step named "${stepName}"`);
      } else if (original !== copy) {
        failures.push(
          `${name}: "${stepName}" differs from deploy-aws.yml's step of the same name; a config redeploy must sync and render exactly what a code release does`,
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
