#!/usr/bin/env bun

/**
 * Mutation-tests `validate-bun-pins.mjs` against scratch git trees, so its real
 * tracked-file listing runs. Each failing case breaks exactly one pin and must
 * fail naming it; each passing case pins a near-miss that must stay legal. The
 * clean case is asserted first so a validator that fails everything cannot pass.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const validator = resolve(repositoryRoot, 'scripts/validate-bun-pins.mjs');

const PIN = '1.4.3';
const manifest = (packageManager = `bun@${PIN}`) =>
  `${JSON.stringify({ name: 'fixture', private: true, packageManager }, null, 2)}\n`;
const dockerfile = (first = `oven/bun:${PIN}-alpine`, second = `oven/bun:${PIN}-alpine`) =>
  `# syntax=docker/dockerfile:1.7\nFROM ${first} AS manifests\nRUN bun install --frozen-lockfile\nFROM manifests AS builder\nFROM ${second} AS runtime\n`;
// biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template.
const ENV_STEP = 'bun-version: ${{ env.BUN_VERSION }}';
const workflow = ({ env = `'${PIN}'`, step = ENV_STEP } = {}) =>
  `name: CI\non: push\nenv:\n  BUN_VERSION: ${env}\njobs:\n  quality:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2\n        with:\n          ${step}\n`;

const base = () => ({
  'package.json': manifest(),
  'packages/backend/Dockerfile': dockerfile(),
  'packages/mcp/Dockerfile': dockerfile(`oven/bun:${PIN}-slim`, `oven/bun:${PIN}-slim`),
  '.github/workflows/ci.yml': workflow(),
});

async function runAgainst(files) {
  const root = await mkdtemp(join(tmpdir(), 'bun-pins-validator-'));
  try {
    for (const [path, contents] of Object.entries(files)) {
      if (contents == null) continue;
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents);
    }
    Bun.spawnSync({ cmd: ['git', '-c', 'init.defaultBranch=main', 'init', '-q'], cwd: root });
    Bun.spawnSync({ cmd: ['git', 'add', '-A', '-f'], cwd: root });
    const result = Bun.spawnSync({
      cmd: ['bun', validator],
      env: { ...process.env, BUN_PINS_VALIDATOR_ROOT: root },
    });
    return { code: result.exitCode, output: `${result.stdout}${result.stderr}` };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const cases = [
  { name: 'a tree pinned everywhere passes', files: base(), pass: true },
  {
    name: 'a runtime stage on another bun fails',
    files: {
      ...base(),
      'packages/backend/Dockerfile': dockerfile(undefined, 'oven/bun:1.4.2-alpine'),
    },
    pass: false,
    expect: 'packages/backend/Dockerfile:5 uses oven/bun:1.4.2-alpine',
  },
  {
    name: 'a stage behind --platform is still read',
    files: {
      ...base(),
      'packages/mcp/Dockerfile': dockerfile(`--platform=linux/arm64 oven/bun:1.5.0-slim`),
    },
    pass: false,
    expect: 'oven/bun:1.5.0-slim',
  },
  {
    name: 'an untagged oven/bun is latest, which is not a pin',
    files: { ...base(), 'packages/mcp/Dockerfile': dockerfile('oven/bun') },
    pass: false,
    expect: 'oven/bun:latest',
  },
  {
    name: 'COPY --from an oven/bun image is a pin too',
    files: {
      ...base(),
      'packages/mcp/Dockerfile': `${dockerfile()}COPY --from=oven/bun:1.3.14 /usr/local/bin/bun /usr/local/bin/bun\n`,
    },
    pass: false,
    expect: 'oven/bun:1.3.14',
  },
  {
    name: 'a commented-out stage on another bun stays legal',
    files: {
      ...base(),
      'packages/backend/Dockerfile': `# FROM oven/bun:1.3.14-alpine\n${dockerfile()}`,
    },
    pass: true,
  },
  {
    name: 'packageManager moving without the images fails',
    files: { ...base(), 'package.json': manifest('bun@1.4.4') },
    pass: false,
    expect: 'package.json pins bun@1.4.4',
  },
  {
    name: 'a workflow BUN_VERSION on another bun fails',
    files: { ...base(), '.github/workflows/ci.yml': workflow({ env: "'1.4.2'" }) },
    pass: false,
    expect: "sets BUN_VERSION '1.4.2'",
  },
  {
    name: 'a literal setup-bun version on another bun fails',
    files: {
      ...base(),
      '.github/workflows/deploy.yml': workflow({ step: 'bun-version: "1.4.2"' }),
    },
    pass: false,
    expect: "deploy.yml job quality step 1 (setup-bun) installs bun '1.4.2'",
  },
  {
    name: 'a setup-bun with no version fails',
    files: { ...base(), '.github/workflows/deploy.yml': workflow({ step: 'no-cache: true' }) },
    pass: false,
    expect: 'names no bun-version',
  },
  {
    name: 'reading package.json is a pin, not a copy',
    files: {
      ...base(),
      '.github/workflows/deploy.yml': workflow({ step: 'bun-version-file: package.json' }),
    },
    pass: true,
  },
  {
    name: 'a missing packageManager fails instead of passing vacuously',
    files: { ...base(), 'package.json': manifest('bun') },
    pass: false,
    expect: 'must pin packageManager',
  },
  {
    name: 'no oven/bun stage at all fails instead of passing vacuously',
    files: {
      ...base(),
      'packages/backend/Dockerfile': null,
      'packages/mcp/Dockerfile': 'FROM node:24\n',
    },
    pass: false,
    expect: 'found no `FROM oven/bun` stage',
  },
  {
    name: 'no setup-bun step at all fails instead of passing vacuously',
    files: { ...base(), '.github/workflows/ci.yml': 'name: CI\non: push\njobs: {}\n' },
    pass: false,
    expect: 'found no oven-sh/setup-bun step',
  },
];

let failed = 0;
for (const testCase of cases) {
  const { code, output } = await runAgainst(testCase.files);
  const passed = code === 0;
  let problem = null;
  if (passed !== testCase.pass) {
    problem = `expected ${testCase.pass ? 'pass' : 'failure'}, got exit ${code}`;
  } else if (!testCase.pass && !output.includes(testCase.expect)) {
    problem = `failed, but never said ${JSON.stringify(testCase.expect)}`;
  }
  if (problem) {
    failed += 1;
    console.error(`not ok - ${testCase.name}: ${problem}\n${output}`);
  } else {
    console.log(`ok - ${testCase.name}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length} bun-pin validator case(s) failed.`);
  process.exit(1);
}
console.log('\nbun-pin validator self-test passed');
