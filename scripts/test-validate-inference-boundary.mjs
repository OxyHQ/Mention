#!/usr/bin/env bun

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const validator = resolve(repositoryRoot, 'scripts/validate-inference-boundary.mjs');

const cleanFiles = {
  'packages/backend/package.json': JSON.stringify({ dependencies: { '@oxyhq/core': '^23.2.0' } }),
  'packages/backend/src/edge.ts': "import { OxyInferenceClient } from '@oxyhq/core';\nexport { OxyInferenceClient };\n",
  'packages/backend/.env.example': 'OXY_INFERENCE_ROUTING_PROFILE_ID=01a06477-94f5-74f0-bc25-4c5c13b93ccd\n',
  '.github/workflows/deploy-aws.yml': [
    'env:',
    '  TASK_ENV_OVERRIDES_JSON: >-',
    '    {"OXY_INFERENCE_ROUTING_PROFILE_ID":"01a06477-94f5-74f0-bc25-4c5c13b93ccd"}',
    '  TASK_SECRET_REMOVALS: ALIA_API_KEY OXY_SERVICE_TOKEN',
    '',
  ].join('\n'),
};

async function runCase(name, additions, expectedFailure) {
  const root = await mkdtemp(join(tmpdir(), 'mention-inference-boundary-'));
  try {
    const files = { ...cleanFiles, ...additions };
    for (const [relativePath, contents] of Object.entries(files)) {
      const path = join(root, relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents);
    }
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root });
    Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root });
    const run = Bun.spawnSync({
      cmd: ['bun', validator],
      cwd: repositoryRoot,
      env: { ...process.env, INFERENCE_BOUNDARY_ROOT: root, INFERENCE_BOUNDARY_FIXTURE: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = `${run.stdout.toString()}${run.stderr.toString()}`;
    if (expectedFailure) {
      if (run.exitCode === 0 || !output.includes(expectedFailure)) {
        throw new Error(`${name}: expected failure containing ${expectedFailure}\n${output}`);
      }
    } else if (run.exitCode !== 0) {
      throw new Error(`${name}: expected success\n${output}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await runCase('clean edge consumer', {}, null);
await runCase('provider env', {
  'packages/backend/src/provider.ts': 'export const key = process.env.OPENAI_API_KEY;\n',
}, 'provider API-key environment variable');
await runCase('provider sdk', {
  'packages/backend/package.json': JSON.stringify({ dependencies: { openai: '^6.0.0' } }),
}, 'direct provider dependency openai');
await runCase('legacy gateway', {
  'packages/backend/src/legacy.ts': 'export const url = process.env.ALIA_API_URL;\n',
}, 'retired Alia provider gateway variable');
await runCase('static Oxy service token', {
  'packages/backend/src/legacy-token.ts': 'export const token = process.env.OXY_SERVICE_TOKEN;\n',
}, 'retired static Oxy service-token fallback');
await runCase('routing-profile slug selector', {
  'packages/backend/src/legacy-routing.ts': "export const request = { routingProfile: 'mention-default' };\n",
}, 'routing-profile slug request field');
await runCase('retired routing-profile environment variable', {
  'packages/backend/.env.example': 'OXY_INFERENCE_ROUTING_PROFILE=mention-default\n',
}, 'retired mutable routing-profile selector');
await runCase('wrong routing-profile ID', {
  'packages/backend/.env.example': 'OXY_INFERENCE_ROUTING_PROFILE_ID=other-profile-id\n',
}, 'must pin Mention\'s exact opaque routing-profile ID');
await runCase('lost retirement assertion', {
  '.github/workflows/deploy-aws.yml': [
    'env:',
    '  TASK_ENV_OVERRIDES_JSON: >-',
    '    {"OXY_INFERENCE_ROUTING_PROFILE_ID":"01a06477-94f5-74f0-bc25-4c5c13b93ccd"}',
    '',
  ].join('\n'),
}, 'must re-assert removal of ALIA_API_KEY');

console.log('Inference boundary mutation tests passed (9 cases).');
