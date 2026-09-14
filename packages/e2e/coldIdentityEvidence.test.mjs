import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateColdEvidence, validateColdAppOrigin } from './coldIdentityEvidence.ts';

const now = Date.parse('2026-09-13T10:00:00Z');
function fixture() {
  const identifiers = { actorUri: 'https://bridge.example/users/alice', canonicalAcct: 'alice@instagram.com', transportAcct: 'alice@bridge.example' };
  const sha = 'a'.repeat(40), imageDigest = `sha256:${'b'.repeat(64)}`;
  const observedAt = '2026-09-13T09:55:00Z';
  const manifest = { sources: [{ ...identifiers, oxyRunReport: 'run', oxySummaryReport: 'oxy', mentionReport: 'mention' }],
    oxySha: sha, mentionSha: sha, oxyDigest: imageDigest, mentionDigest: imageDigest,
    expectedBioText: 'An actual source biography', expectedMentionLabel: '@friend@instagram.com', expectedMentionHandle: 'friend@instagram.com', forbiddenBioText: ['Bridged by Example'] };
  const reports = {
    run: { operation: 'inspect_cache', dryRun: true, identifiers, expectedSourceSha: sha, imageDigest },
    oxy: { operation: 'inspect_cache', sourceSha: sha, imageDigest, observedAt, absent: true, counts: { users: 0, registryActors: 0, registryIdentities: 0 } },
    mention: { operation: 'inspect_cache', dryRun: true, identifiers, sourceSha: sha, imageDigest, exitCode: 0, observedAt,
      report: { actorUriMatches: 0, canonicalAcctMatches: 0, transportAcctMatches: 0, postSourceMatches: 0 } },
  };
  return { manifest, reports, validate: () => validateColdEvidence(manifest, path => reports[path], now) };
}
test('accepts only matching pre-discovery zero reports', () => { assert.equal(fixture().validate().sources.length, 1); });
for (const [name, mutate] of [
  ['existing Oxy user', f => { f.reports.oxy.counts.users = 1; }],
  ['missing source reports', f => { f.manifest.sources = []; }],
  ['non-read-only report', f => { f.reports.run.dryRun = false; }],
  ['existing Mention post', f => { f.reports.mention.report.postSourceMatches = 1; }],
  ['different source', f => { f.reports.mention.identifiers = { ...f.reports.mention.identifiers, actorUri: 'https://other.example/actor' }; }],
  ['different image', f => { f.reports.oxy.imageDigest = `sha256:${'c'.repeat(64)}`; }],
  ['different revision', f => { f.reports.run.expectedSourceSha = 'd'.repeat(40); }],
  ['reconcile preview', f => { f.reports.mention.operation = 'reconcile'; }],
  ['failed inspection', f => { f.reports.mention.exitCode = 1; }],
  ['future inspection', f => { f.reports.oxy.observedAt = '2026-09-13T10:01:00Z'; }],
  ['stale inspection', f => { f.reports.oxy.observedAt = '2026-09-13T08:00:00Z'; }],
  ['unknown count', f => { delete f.reports.oxy.counts.registryActors; }],
  ['no reviewed boilerplate', f => { f.manifest.forbiddenBioText = []; }],
]) test(`refuses ${name} before any discovery`, () => { const f = fixture(); mutate(f); assert.throws(f.validate); });

test('cold gate refuses static previews that bypass server HTML', () => {
  assert.throws(() => validateColdAppOrigin('https://preview.pages.dev', 'https://mention.earth'), /deployed app origin/);
});
test('cold gate accepts the deployed app origin', () => {
  assert.doesNotThrow(() => validateColdAppOrigin('https://mention.earth', 'https://mention.earth'));
});

// Exercise module initialization and the real preflight together: validating
// origins in isolation cannot catch an earlier environment import rejecting them.
function runColdModule(module, { optIn = '1', candidate = 'https://app.example', evidence = '' } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MENTION_E2E_')));
  const url = new URL(module, import.meta.url).href;
  return spawnSync('bun', ['--eval', `
    globalThis.fetch = () => { throw new Error('Offline controls must never fetch'); };
    const loaded = await import(${JSON.stringify(url)});
    if (loaded.default) loaded.default();
  `], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...env, MENTION_E2E_CANDIDATE_ORIGIN: candidate, MENTION_E2E_APP_ORIGIN: 'https://app.example',
      ...(optIn ? { MENTION_E2E_COLD_IDENTITY: optIn } : {}), MENTION_E2E_COLD_EVIDENCE: evidence },
  });
}

test('environment accepts matching origins only with explicit cold opt-in', () => {
  const result = runColdModule('./environment.ts');
  assert.equal(result.status, 0, result.stderr);
  for (const optIn of ['', '0', 'true']) {
    const rejected = runColdModule('./environment.ts', { optIn });
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stderr, /must differ from MENTION_E2E_APP_ORIGIN/);
  }
});

test('ordinary environment still accepts an isolated candidate', () => {
  const result = runColdModule('./environment.ts', { optIn: '', candidate: 'https://preview.example' });
  assert.equal(result.status, 0, result.stderr);
});

test('actual cold preflight refuses different origins before loading evidence', () => {
  const result = runColdModule('./coldIdentityPreflight.ts', { candidate: 'https://preview.example' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /deployed app origin/);
});

test('actual cold preflight still requires fresh database absence evidence', t => {
  const directory = mkdtempSync(join(tmpdir(), 'mention-cold-environment-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const evidence = join(directory, 'manifest.json');
  const f = fixture();
  f.reports.oxy.observedAt = f.reports.mention.observedAt = new Date().toISOString();
  writeFileSync(evidence, JSON.stringify(f.manifest));
  const writeReports = () => {
    for (const [name, report] of Object.entries(f.reports)) writeFileSync(join(directory, name), JSON.stringify(report));
  };
  writeReports();
  const accepted = runColdModule('./coldIdentityPreflight.ts', { evidence });
  assert.equal(accepted.status, 0, accepted.stderr);

  const missing = runColdModule('./coldIdentityPreflight.ts');
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /Missing evidence string/);

  f.reports.mention.report.postSourceMatches = 1;
  writeReports();
  const existing = runColdModule('./coldIdentityPreflight.ts', { evidence });
  assert.equal(existing.status, 1, existing.stderr);
  assert.match(existing.stderr, /Evidence mismatch: postSourceMatches/);

  f.reports.mention.report.postSourceMatches = 0;
  f.reports.oxy.observedAt = new Date(Date.now() - 31 * 60_000).toISOString();
  writeReports();
  const stale = runColdModule('./coldIdentityPreflight.ts', { evidence });
  assert.equal(stale.status, 1, stale.stderr);
  assert.match(stale.stderr, /Inspection must precede discovery by at most 30 minutes/);
});
