#!/usr/bin/env bun
import { mkdtemp, mkdir, readFile, writeFile, cp, symlink, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await mkdtemp(join(tmpdir(), 'mention-lock-vendor-'));
try {
  await mkdir(join(fixture, 'scripts'));
  await cp(
    join(root, 'scripts/validate-lockfile.mjs'),
    join(fixture, 'scripts/validate-lockfile.mjs'),
  );
  await cp(join(root, 'vendor'), join(fixture, 'vendor'), { recursive: true });
  await cp(join(root, 'package.json'), join(fixture, 'package.json'));
  await symlink(join(root, 'node_modules'), join(fixture, 'node_modules'), 'dir');
  for (const name of ['backend', 'frontend', 'shared-types', 'mcp', 'e2e']) {
    await mkdir(join(fixture, 'packages', name), { recursive: true });
    await cp(
      join(root, 'packages', name, 'package.json'),
      join(fixture, 'packages', name, 'package.json'),
    );
  }
  for (const name of ['backend', 'mcp'])
    await cp(
      join(root, 'packages', name, 'Dockerfile'),
      join(fixture, 'packages', name, 'Dockerfile'),
    );
  const original = await readFile(join(root, 'bun.lock'), 'utf8');
  const run = async (source = original) => {
    await writeFile(join(fixture, 'bun.lock'), source);
    const result = Bun.spawnSync(['bun', join(fixture, 'scripts/validate-lockfile.mjs')]);
    return { code: result.exitCode, output: `${result.stdout}${result.stderr}` };
  };
  assert.equal((await run()).code, 0, 'reviewed artifacts should pass');
  const alternate = await run(
    original.replace('@homiio/sdk@../../vendor/', '@homiio/sdk@../../../vendor/'),
  );
  assert.notEqual(alternate.code, 0, 'alternate file paths must fail');
  assert.match(alternate.output, /neither the registry nor an allowed protocol/);
  const badIntegrity = await run(original.replace('sha512-JbxPaEor', 'sha512-XbxPaEor'));
  assert.notEqual(badIntegrity.code, 0, 'changed lockfile digest must fail');
  assert.match(badIntegrity.output, /vendored artifact integrity/);
  await writeFile(join(fixture, 'vendor/homiio-sdk-0.1.0.tgz'), 'tampered');
  const tampered = await run();
  assert.notEqual(tampered.code, 0, 'changed artifact bytes must fail');
  assert.match(tampered.output, /vendored artifact integrity/);
  await rm(join(fixture, 'vendor/homiio-sdk-0.1.0.tgz'));
  const missing = await run();
  assert.notEqual(missing.code, 0, 'missing artifact must fail');
  assert.match(missing.output, /vendored artifact is missing/);
  console.log('Passed 5 vendored lockfile integrity/mutation checks');
} finally {
  await rm(fixture, { recursive: true, force: true });
}
