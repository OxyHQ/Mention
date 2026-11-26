#!/usr/bin/env bun

/**
 * Mutation-tests `validate-source-rules.mjs`.
 *
 * A validator that passes on a clean tree proves nothing alone: it would also
 * pass if its traversal found no files or its matcher never matched. Each
 * `offence` case adds exactly one violation to an otherwise clean scratch tree
 * and requires the validator to fail NAMING THAT RULE. Each `allowed` case adds
 * the nearest legitimate look-alike and requires the validator to stay quiet,
 * which pins the rule's scope (a gate that cries wolf gets switched off).
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const validator = resolve(repositoryRoot, 'scripts/validate-source-rules.mjs');

const HLS_SITE = 'packages/frontend/lib/hlsPlayback.web.ts';
const HLS_SOURCE = "export const load = () => import('hls.js');\n";

/** Enough clean files to clear every vacuity floor, plus the hls anchor. */
function cleanTree() {
  const files = { [HLS_SITE]: HLS_SOURCE };
  for (let index = 0; index < 900; index += 1) {
    files[`packages/frontend/generated/file-${index}.ts`] =
      `export const value${index} = ${index};\n`;
  }
  for (let index = 0; index < 450; index += 1) {
    files[`packages/backend/src/generated/file-${index}.ts`] =
      `export const value${index} = ${index};\n`;
  }
  return files;
}

async function runAgainst(files) {
  const root = await mkdtemp(join(tmpdir(), 'source-rules-'));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents);
    }
    // Run the REAL validator (so it resolves `typescript` from this repo)
    // against the scratch tree.
    const proc = Bun.spawnSync({
      cmd: ['bun', validator],
      cwd: repositoryRoot,
      env: { ...process.env, SOURCE_RULES_ROOT: root },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { exitCode: proc.exitCode, output: `${proc.stdout}${proc.stderr}` };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const offence = (rule, path, contents) => ({
  name: `${rule}: ${path}`,
  rule,
  extra: { [path]: contents },
});
const allowed = (name, path, contents) => ({ name, rule: null, extra: { [path]: contents } });

const cases = [
  { name: 'clean tree passes', rule: null, extra: {} },

  offence('backend-console', 'packages/backend/src/offender.ts', "console.log('x');\n"),
  offence('backend-console', 'packages/backend/src/offender.ts', "console.info('x');\n"),
  allowed(
    'backend-console: console.error is allowed',
    'packages/backend/src/ok.ts',
    "console.error('x');\n",
  ),
  allowed(
    'backend-console: operator scripts may print',
    'packages/backend/src/scripts/cli.ts',
    "console.log('x');\n",
  ),
  allowed(
    'backend-console: tests may print',
    'packages/backend/src/__tests__/t.test.ts',
    "console.log('x');\n",
  ),
  allowed(
    'backend-console: a comment is not a call',
    'packages/backend/src/ok.ts',
    '// console.log is banned\n',
  ),

  offence(
    'no-react-virtual',
    'packages/frontend/a.ts',
    "import { useVirtualizer } from '@tanstack/react-virtual';\n",
  ),
  offence(
    'no-react-virtual',
    'packages/frontend/a.ts',
    "export const v = await import('@tanstack/react-virtual');\n",
  ),
  offence(
    'no-react-virtual',
    'packages/frontend/a.ts',
    "export const v = require('@tanstack/react-virtual');\n",
  ),
  allowed(
    'no-react-virtual: a comment is not an import',
    'packages/frontend/ok.ts',
    "// from '@tanstack/react-virtual'\n",
  ),

  offence(
    'hls-single-import',
    'packages/frontend/a.ts',
    "export const h = () => import('hls.js');\n",
  ),
  offence(
    'hls-single-import',
    'packages/frontend/a.ts',
    "import Hls from 'hls.js';\nexport { Hls };\n",
  ),
  offence('hls-single-import', HLS_SITE, "import Hls from 'hls.js';\nexport { Hls };\n"),
  allowed(
    'hls-single-import: type-only import is erased',
    'packages/frontend/ok.ts',
    "import type HlsJs from 'hls.js';\nexport type T = HlsJs;\n",
  ),

  offence(
    'no-can-play-type',
    'packages/frontend/a.ts',
    "export const s = (v: HTMLVideoElement) => v.canPlayType('video/mp4');\n",
  ),
  allowed(
    'no-can-play-type: a comment is not a call',
    'packages/frontend/ok.ts',
    '// not video.canPlayType(x)\n',
  ),

  offence(
    'no-router-singleton',
    'packages/frontend/a.ts',
    "import { router } from 'expo-router';\nexport const go = () => router.push('/');\n",
  ),
  offence(
    'no-router-singleton',
    'packages/frontend/a.ts',
    "import { router as r } from 'expo-router';\nexport { r };\n",
  ),
  allowed(
    'no-router-singleton: useRouter is the hook',
    'packages/frontend/ok.ts',
    "import { useRouter } from 'expo-router';\nexport { useRouter };\n",
  ),
  allowed(
    'no-router-singleton: perf harness may use it',
    'packages/frontend/components/__perf__/h.tsx',
    "import { router } from 'expo-router';\nexport { router };\n",
  ),

  offence(
    'no-viewport-height-literal',
    'packages/frontend/a.ts',
    "export const s = { minHeight: '100vh' };\n",
  ),
  offence(
    'no-viewport-height-literal',
    'packages/frontend/a.ts',
    `export const s = \`calc(100vh - \${1}px)\`;\n`,
  ),
  allowed(
    'no-viewport-height-literal: 100dvh is a different unit',
    'packages/frontend/ok.ts',
    "export const s = { minHeight: '100dvh' };\n",
  ),
  allowed(
    'no-viewport-height-literal: a comment is not a style',
    'packages/frontend/ok.ts',
    '// never 100vh\n',
  ),
];

const failed = [];

for (const testCase of cases) {
  const result = await runAgainst({ ...cleanTree(), ...testCase.extra });
  let problem = null;
  if (testCase.rule === null) {
    if (result.exitCode !== 0)
      problem = `expected a clean run, got exit ${result.exitCode}:\n${result.output}`;
  } else if (result.exitCode === 0) {
    problem = 'expected a failure, but the validator passed';
  } else if (!result.output.includes(`[${testCase.rule}]`)) {
    problem = `failed, but not for rule ${testCase.rule}:\n${result.output}`;
  }
  if (problem) failed.push(`${testCase.name}: ${problem}`);
}

// Vacuity: an empty tree must fail loudly, never report clean.
const empty = await runAgainst({});
if (empty.exitCode === 0) failed.push('an empty tree passed: the vacuity floors are not enforced');

// The hls rule needs its anchor file.
const noAnchor = await runAgainst(
  Object.fromEntries(Object.entries(cleanTree()).filter(([path]) => path !== HLS_SITE)),
);
if (noAnchor.exitCode === 0 || !noAnchor.output.includes('[hls-single-import]')) {
  failed.push('a tree without lib/hlsPlayback.web.ts passed');
}

if (failed.length > 0) {
  console.error(`test-validate-source-rules: ${failed.length} case(s) failed\n`);
  for (const message of failed) console.error(`  ${message}`);
  process.exit(1);
}

console.log(`test-validate-source-rules: ${cases.length + 2} cases passed`);
