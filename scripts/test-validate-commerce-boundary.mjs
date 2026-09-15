#!/usr/bin/env bun

/**
 * Mutation tests for `validate-commerce-boundary.mjs`. Each case builds a
 * scratch git repository, runs the real validator against it, and asserts the
 * exact finding — so every syntactic form the validator claims to see has a
 * case that fails if that form stops being seen, and every deliberate allowance
 * has a case that fails if it starts being flagged.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const validator = resolve(repositoryRoot, 'scripts/validate-commerce-boundary.mjs');

const HOST = 'Mercaria host outside the SDK';
const PATH = 'Mercaria public API path outside the SDK';

const cleanFiles = {
  'packages/backend/src/services/commerce/mercariaClient.ts':
    "import { createMercariaClient } from '@mercaria.co/sdk';\nexport const client = createMercariaClient();\n",
  'packages/backend/src/services/commerce/mercariaHydration.ts': [
    '// Reads go to https://api.mercaria.co/public/v1 — through the SDK, never from here.',
    "import { parseMercariaRef } from '@mercaria.co/sdk';",
    'export const parse = parseMercariaRef;',
    '',
  ].join('\n'),
};

let caseCount = 0;
async function runCase(name, additions, expected, untracked = {}) {
  caseCount += 1;
  const root = await mkdtemp(join(tmpdir(), 'mention-commerce-boundary-'));
  try {
    const files = { ...cleanFiles, ...additions };
    for (const [relativePath, contents] of Object.entries(files)) {
      if (contents === null) continue;
      const path = join(root, relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents);
    }
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root });
    Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root });
    // Written AFTER staging: a file an author has not `git add`ed yet is still
    // production source the validator must read.
    for (const [relativePath, contents] of Object.entries(untracked)) {
      const path = join(root, relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents);
    }
    const run = Bun.spawnSync({
      cmd: ['bun', validator],
      cwd: repositoryRoot,
      env: { ...process.env, COMMERCE_BOUNDARY_ROOT: root, COMMERCE_BOUNDARY_FIXTURE: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = `${run.stdout.toString()}${run.stderr.toString()}`;
    if (expected) {
      if (run.exitCode === 0 || !output.includes(expected)) {
        throw new Error(`${name}: expected failure containing ${JSON.stringify(expected)}\n${output}`);
      }
    } else if (run.exitCode !== 0 || !output.includes('Validated')) {
      throw new Error(`${name}: expected success\n${output}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ── Allowed: must stay green ────────────────────────────────────────────────

await runCase('SDK consumers, with the rule explained in comments', {}, null);
await runCase('the exempt client module may name a Mercaria origin', {
  'packages/backend/src/services/commerce/mercariaClient.ts': [
    "import { createMercariaClient } from '@mercaria.co/sdk';",
    "export const client = createMercariaClient({ apiBaseUrl: 'https://api.mercaria.co' });",
    "export const probe = '/public/v1/products';",
    '',
  ].join('\n'),
}, null);
await runCase('tests, fixtures, mocks and the e2e package are outside the population', {
  'packages/backend/src/__tests__/commerce.test.ts': "export const url = 'https://api.mercaria.co/public/v1/products/p';\n",
  'packages/frontend/__mocks__/mercaria.ts': "export const url = 'https://mercaria.co/products/p';\n",
  'packages/mcp/lib/commerce.spec.ts': "export const url = 'https://mercaria.co';\n",
  'packages/shared-types/src/fixtures/product.ts': "export const url = 'https://mercaria.co';\n",
  // Outside `tests/` on purpose, so only the package exclusion keeps it out.
  'packages/e2e/environment.ts': "export const url = 'https://mercaria.co/public/v1';\n",
}, null);
await runCase('similar-looking strings that are not a Mercaria host or route', {
  'packages/frontend/components/Similar.tsx': [
    "import type { MercariaProduct } from '@mercaria.co/sdk';",
    "export const other = 'https://mercaria.com/x';",
    "export const brand = 'supermercaria.co.uk';",
    "export const email = 'help@mercaria.co';",
    "export const oxy = '/public/v10';",
    "export const unrelated = '/api/public/v1beta';",
    'export type P = MercariaProduct;',
    '',
  ].join('\n'),
}, null);

// ── Forbidden: every form must be seen ──────────────────────────────────────

await runCase('host in a string literal', {
  'packages/backend/src/services/shop.ts': "export const base = 'https://api.mercaria.co';\n",
}, `packages/backend/src/services/shop.ts:1: ${HOST}`);
await runCase('apex host without a scheme, mixed case', {
  'packages/mcp/lib/shop.ts': "export const host = 'Mercaria.CO';\n",
}, `packages/mcp/lib/shop.ts:1: ${HOST}`);
await runCase('host in a no-substitution template literal', {
  'packages/shared-types/src/shop.ts': 'export const base = `https://mercaria.co`;\n',
}, `packages/shared-types/src/shop.ts:1: ${HOST}`);
await runCase('host in a template tail after a substitution', {
  'packages/backend/src/services/shop.ts': 'const env = "api";\nexport const base = `https://${env}.mercaria.co/x`;\n',
}, `packages/backend/src/services/shop.ts:2: ${HOST}`);
await runCase('path in a template middle', {
  'packages/backend/src/services/shop.ts':
    "const base = 'x';\nconst id = 'p';\nexport const url = `${base}/public/v1/products/${id}`;\n",
}, `packages/backend/src/services/shop.ts:3: ${PATH}`);
await runCase('path in a template head', {
  'packages/frontend/lib/shop.ts': "const id = 'p';\nexport const url = `/public/v1/products/${id}`;\n",
}, `packages/frontend/lib/shop.ts:2: ${PATH}`);
await runCase('path without its leading slash', {
  'packages/frontend/lib/shop.ts': "export const route = 'public/v1/stores';\n",
}, `packages/frontend/lib/shop.ts:1: ${PATH}`);
await runCase('host in a regular-expression literal', {
  'packages/backend/src/utils/shop.ts': 'export const isShop = /^https:\\/\\/mercaria\\.co\\//;\n',
}, `packages/backend/src/utils/shop.ts:1: ${HOST}`);
await runCase('escaped host and path in a string handed to new RegExp', {
  'packages/backend/src/utils/shop.ts': "export const route = new RegExp('^https://api\\\\.mercaria\\\\.co\\\\/public\\\\/v1');\n",
}, `packages/backend/src/utils/shop.ts:1: ${PATH}`);
await runCase('host in JSX text', {
  'packages/frontend/components/Shop.tsx': 'export const Shop = () => <Text>Buy it on mercaria.co today</Text>;\n',
}, `packages/frontend/components/Shop.tsx:1: ${HOST}`);
await runCase('host in a JSX attribute', {
  'packages/frontend/components/Shop.tsx': 'export const Shop = () => <Link href="https://mercaria.co/stores/x">Shop</Link>;\n',
}, `packages/frontend/components/Shop.tsx:1: ${HOST}`);
await runCase('host in a plain .js file', {
  'packages/frontend/utils/shop.js': "module.exports = { base: 'https://mercaria.co' };\n",
}, `packages/frontend/utils/shop.js:1: ${HOST}`);
await runCase('path in an .mjs file', {
  'packages/mcp/lib/shop.mjs': "export const route = '/public/v1/collections';\n",
}, `packages/mcp/lib/shop.mjs:1: ${PATH}`);
await runCase('host in an untracked (not yet staged) file', {}, `packages/backend/src/services/untracked.ts:1: ${HOST}`, {
  'packages/backend/src/services/untracked.ts': "export const base = 'https://mercaria.co';\n",
});

// ── The gate's own integrity ────────────────────────────────────────────────

await runCase('a stale exemption fails', {
  'packages/backend/src/services/commerce/mercariaClient.ts': null,
}, 'exempt from the commerce boundary but not a production source file');
await runCase('a scan that never sees the SDK import cannot report clean', {
  'packages/backend/src/services/commerce/mercariaClient.ts': 'export const client = null;\n',
  'packages/backend/src/services/commerce/mercariaHydration.ts': 'export const parse = null;\n',
}, 'no "@mercaria.co/sdk" literal was seen');
await runCase('an SDK import mentioned only in a comment is not a sighting', {
  'packages/backend/src/services/commerce/mercariaClient.ts': "// import from '@mercaria.co/sdk'\nexport const client = null;\n",
  'packages/backend/src/services/commerce/mercariaHydration.ts': 'export const parse = null;\n',
}, 'no "@mercaria.co/sdk" literal was seen');

console.log(`Commerce boundary mutation tests passed (${caseCount} cases).`);
