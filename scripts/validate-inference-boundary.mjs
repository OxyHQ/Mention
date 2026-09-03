#!/usr/bin/env bun

/**
 * Mention is an inference CONSUMER. Provider credentials, endpoints and SDKs
 * belong to Kaana; this repository may select only Mention's reviewed Oxy
 * routing profile by its exact opaque primary key.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = process.env.INFERENCE_BOUNDARY_ROOT
  ? resolve(process.env.INFERENCE_BOUNDARY_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routingProfileIdName = 'OXY_INFERENCE_ROUTING_PROFILE_ID';
const routingProfileId = '01a06477-94f5-74f0-bc25-4c5c13b93ccd';

const listed = Bun.spawnSync({
  cmd: ['git', 'ls-files', '--cached', '--others', '--exclude-standard'],
  cwd: repositoryRoot,
  stdout: 'pipe',
  stderr: 'pipe',
});
if (listed.exitCode !== 0) {
  throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
}

const sourceFiles = listed.stdout.toString()
  .split('\n')
  .filter((file) => file.startsWith('packages/backend/src/') && /\.(?:ts|tsx|js|mjs|cjs)$/.test(file))
  .filter((file) => existsSync(resolve(repositoryRoot, file)));

const failures = [];
if (sourceFiles.length < (process.env.INFERENCE_BOUNDARY_FIXTURE === '1' ? 1 : 900)) {
  failures.push(`backend source listing is unexpectedly small (${sourceFiles.length} files)`);
}

const forbiddenSourcePatterns = [
  [/\b(?:OPENAI|ANTHROPIC|GROQ|OPENROUTER|MISTRAL|DEEPSEEK|CEREBRAS|TOGETHER|FIREWORKS|XAI)_API_KEY\b/, 'provider API-key environment variable'],
  [/\bALIA_API_(?:KEY|URL)\b/, 'retired Alia provider gateway variable'],
  [/\bOXY_SERVICE_TOKEN\b/, 'retired static Oxy service-token fallback'],
  [/(?:api\.openai\.com|api\.anthropic\.com|api\.groq\.com|openrouter\.ai\/api)/, 'direct provider endpoint'],
  [/(?:from\s+|require\()['"](?:openai|@anthropic-ai\/sdk|groq-sdk|@ai-sdk\/(?:openai|anthropic|groq|mistral|xai))['"]/, 'direct provider SDK import'],
  [/(?:from\s+|require\()['"][^'"]*\/utils\/alia['"]/, 'retired Alia inference utility import'],
  [/\bOXY_INFERENCE_ROUTING_PROFILE\b/, 'retired mutable routing-profile selector'],
  [/\broutingProfile\s*:/, 'routing-profile slug request field'],
];

for (const file of sourceFiles) {
  const text = await readFile(resolve(repositoryRoot, file), 'utf8');
  for (const [pattern, label] of forbiddenSourcePatterns) {
    if (pattern.test(text)) failures.push(`${file}: ${label}`);
  }
}

const backendManifestPath = resolve(repositoryRoot, 'packages/backend/package.json');
if (existsSync(backendManifestPath)) {
  const manifest = JSON.parse(await readFile(backendManifestPath, 'utf8'));
  const packages = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
  };
  const forbiddenPackages = Object.keys(packages).filter((name) =>
    /^(?:openai|@anthropic-ai\/sdk|groq-sdk|@ai-sdk\/(?:openai|anthropic|groq|mistral|xai))$/.test(name),
  );
  for (const name of forbiddenPackages) failures.push(`packages/backend/package.json: direct provider dependency ${name}`);
}

for (const relativePath of ['packages/backend/.env.example', 'packages/backend/Dockerfile']) {
  const path = resolve(repositoryRoot, relativePath);
  if (!existsSync(path)) continue;
  const text = await readFile(path, 'utf8');
  for (const [pattern, label] of forbiddenSourcePatterns) {
    if (pattern.test(text)) failures.push(`${relativePath}: ${label}`);
  }
}

const environmentExamplePath = resolve(repositoryRoot, 'packages/backend/.env.example');
if (existsSync(environmentExamplePath)) {
  const environmentExample = await readFile(environmentExamplePath, 'utf8');
  if (!environmentExample.includes(`${routingProfileIdName}=${routingProfileId}`)) {
    failures.push('packages/backend/.env.example: must pin Mention\'s exact opaque routing-profile ID');
  }
}

const workflowPath = resolve(repositoryRoot, '.github/workflows/deploy-aws.yml');
if (existsSync(workflowPath)) {
  const workflow = await readFile(workflowPath, 'utf8');
  if (/secrets\.ALIA_API_KEY/.test(workflow)) {
    failures.push('.github/workflows/deploy-aws.yml: still reads the retired ALIA_API_KEY GitHub secret');
  }
  const removals = workflow.match(/^\s*TASK_SECRET_REMOVALS:\s*(.+?)\s*$/m)?.[1]
    ?.split(/\s+/) ?? [];
  for (const retiredSecret of ['ALIA_API_KEY', 'OXY_SERVICE_TOKEN']) {
    if (!removals.includes(retiredSecret)) {
      failures.push(`.github/workflows/deploy-aws.yml: must re-assert removal of ${retiredSecret} from every ECS task revision`);
    }
  }
  if (/\bOXY_INFERENCE_ROUTING_PROFILE\b/.test(workflow)) {
    failures.push('.github/workflows/deploy-aws.yml: still injects the retired mutable routing-profile selector');
  }
  if (!workflow.includes(`{"${routingProfileIdName}":"${routingProfileId}"}`)) {
    failures.push('.github/workflows/deploy-aws.yml: must inject Mention\'s exact opaque routing-profile ID durably');
  }
}

if (failures.length > 0) {
  console.error(`Inference boundary validation failed:\n\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  process.exit(1);
}

console.log(`Validated Mention's Oxy/Kaana inference boundary across ${sourceFiles.length} backend source files.`);
