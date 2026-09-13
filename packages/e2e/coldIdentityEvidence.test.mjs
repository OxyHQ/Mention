import { test } from 'node:test';
import assert from 'node:assert/strict';
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
