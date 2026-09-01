#!/usr/bin/env bun

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const validator = resolve(repositoryRoot, 'scripts/validate-inference-boundary.mjs');

const cleanFiles = {
  'packages/backend/package.json': JSON.stringify({ dependencies: { '@oxyhq/core': '^23.0.0' } }),
  'packages/backend/src/edge.ts': "import { OxyInferenceClient } from '@oxyhq/core';\nexport { OxyInferenceClient };\n",
  'packages/backend/.env.example': 'OXY_INFERENCE_ROUTING_PROFILE=mention-default\n',
  '.github/workflows/deploy-aws.yml': [
    'env:',
    '  TASK_ENV_OVERRIDES_JSON: >-',
    '    {"OXY_INFERENCE_ROUTING_PROFILE":"mention-default"}',
    '  TASK_SECRET_REMOVALS: ALIA_API_KEY',
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
await runCase('lost retirement assertion', {
  '.github/workflows/deploy-aws.yml': [
    'env:',
    '  TASK_ENV_OVERRIDES_JSON: >-',
    '    {"OXY_INFERENCE_ROUTING_PROFILE":"mention-default"}',
    '',
  ].join('\n'),
}, 'must re-assert removal of ALIA_API_KEY');

console.log('Inference boundary mutation tests passed (5 cases).');
