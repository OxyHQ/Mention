#!/usr/bin/env bun

/**
 * Every bun this repository runs must be the bun `packageManager` pins.
 *
 * `packageManager` names the bun that wrote bun.lock, and doctor refuses any
 * other running bun. But three other places name a bun too, and each is a
 * literal nothing compared with it:
 *
 *  - every `FROM oven/bun:<tag>` stage in a tracked Dockerfile, which is the bun
 *    that runs `bun install --frozen-lockfile` in the image build AND the bun
 *    the backend and MCP containers execute on in production;
 *  - each workflow's `BUN_VERSION` env, which every `setup-bun` step reads;
 *  - any `setup-bun` step that names its own `bun-version`.
 *
 * A bump that misses one of them builds the image, or runs CI, on a bun nobody
 * tested against this lockfile. The frozen install then fails in the image
 * build, or worse, passes on a different resolver.
 *
 * A `setup-bun` step with no version at all installs whatever is newest, so it
 * fails too. So does a tree in which no oven/bun stage or setup-bun step is
 * found: a check that measured nothing must not read as a pass.
 */

import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repositoryRoot =
  process.env.BUN_PINS_VALIDATOR_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));
const pinned = /^bun@(\d+\.\d+\.\d+)$/.exec(String(manifest.packageManager ?? ''))?.[1];
if (!pinned) {
  console.error(
    'package.json must pin packageManager as bun@<x.y.z>; without it no other bun pin can be checked.',
  );
  process.exit(1);
}

const listing = Bun.spawnSync({ cmd: ['git', 'ls-files', '-z'], cwd: repositoryRoot });
if (listing.exitCode !== 0) {
  console.error(`git ls-files failed in ${repositoryRoot}: ${listing.stderr}`);
  process.exit(1);
}
const tracked = listing.stdout.toString().split('\0').filter(Boolean);

// --- Dockerfiles ------------------------------------------------------------
const dockerfiles = tracked.filter((path) => /(^|\.)Dockerfile(\.|$)/i.test(basename(path)));
let bunStages = 0;
for (const path of dockerfiles) {
  const lines = readFileSync(resolve(repositoryRoot, path), 'utf8').split('\n');
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line.startsWith('#')) return;
    // `FROM [--platform=…] oven/bun[:tag]` and `COPY --from=oven/bun[:tag]`.
    const match =
      /^FROM\s+(?:--\S+\s+)*oven\/bun(?::(\S+))?(?:\s|$)/i.exec(line) ??
      /^COPY\s+(?:--\S+\s+)*--from=oven\/bun(?::(\S+))?(?:\s|$)/i.exec(line);
    if (!match) return;
    bunStages += 1;
    const tag = match[1] ?? 'latest';
    if (tag.split('-')[0] !== pinned) {
      failures.push(
        `${path}:${index + 1} uses oven/bun:${tag}, but package.json pins bun@${pinned}. ` +
          'The image must run the bun that wrote bun.lock and that CI tests with.',
      );
    }
  });
}
if (bunStages === 0) {
  failures.push(
    `found no \`FROM oven/bun\` stage in ${dockerfiles.length} tracked Dockerfile(s); the image pin check measured nothing.`,
  );
}

// --- Workflows --------------------------------------------------------------
const workflows = tracked.filter((path) => /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path));
const ENV_REFERENCE = /^\$\{\{\s*env\.BUN_VERSION\s*\}\}$/;
let setupSteps = 0;

function checkEnv(env, where) {
  if (env && Object.hasOwn(env, 'BUN_VERSION') && String(env.BUN_VERSION) !== pinned) {
    failures.push(
      `${where} sets BUN_VERSION '${env.BUN_VERSION}', but package.json pins bun@${pinned}.`,
    );
  }
}

for (const path of workflows) {
  let workflow;
  try {
    workflow = parse(readFileSync(resolve(repositoryRoot, path), 'utf8'));
  } catch {
    // A malformed workflow is validate-workflows.mjs's business.
    continue;
  }
  if (!workflow || typeof workflow !== 'object') continue;
  checkEnv(workflow.env, path);
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    checkEnv(job?.env, `${path} job ${jobName}`);
    const resolvedEnv = { ...(workflow.env ?? {}), ...(job?.env ?? {}) };
    for (const [index, step] of (job?.steps ?? []).entries()) {
      if (typeof step?.uses !== 'string' || !step.uses.startsWith('oven-sh/setup-bun@')) continue;
      setupSteps += 1;
      const where = `${path} job ${jobName} step ${index + 1} (setup-bun)`;
      const withs = step.with ?? {};
      const version =
        withs['bun-version'] == null ? undefined : String(withs['bun-version']).trim();
      const versionFile = withs['bun-version-file'];
      if (version === undefined) {
        if (versionFile !== 'package.json') {
          failures.push(
            `${where} names no bun-version and does not read package.json, so it installs whatever bun is newest.`,
          );
        }
      } else if (ENV_REFERENCE.test(version)) {
        if (!Object.hasOwn(resolvedEnv, 'BUN_VERSION')) {
          failures.push(
            `${where} reads env.BUN_VERSION, which neither the workflow nor the job sets.`,
          );
        }
      } else if (version !== pinned) {
        failures.push(`${where} installs bun '${version}', but package.json pins bun@${pinned}.`);
      }
    }
  }
}
if (setupSteps === 0) {
  failures.push(
    `found no oven-sh/setup-bun step in ${workflows.length} workflow(s); the CI pin check measured nothing.`,
  );
}

if (failures.length > 0) {
  console.error('Bun pin drift:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Every bun is bun@${pinned}: ${bunStages} oven/bun stage(s) across ${dockerfiles.length} Dockerfile(s) ` +
    `and ${setupSteps} setup-bun step(s) across ${workflows.length} workflow(s).`,
);
