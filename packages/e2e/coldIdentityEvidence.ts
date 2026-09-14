import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ColdSource {
  actorUri: string;
  canonicalAcct: string;
  transportAcct: string;
  oxyRunReport: string;
  oxySummaryReport: string;
  mentionReport: string;
}
export interface ColdEvidence {
  sources: ColdSource[];
  oxySha: string;
  oxyDigest: string;
  mentionSha: string;
  mentionDigest: string;
  expectedBioText: string;
  expectedMentionLabel: string;
  expectedMentionHandle: string;
  forbiddenBioText: string[];
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected evidence object');
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Missing evidence string');
  return value;
}
function equal(actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) throw new Error(`Evidence mismatch: ${field}`);
}
function timestamp(value: unknown, now: number): void {
  const time = Date.parse(string(value));
  if (!Number.isFinite(time) || time > now || now - time > 30 * 60_000) throw new Error('Inspection must precede discovery by at most 30 minutes');
}
function zeroes(value: unknown, fields: string[]): void {
  const counts = object(value);
  for (const key of fields) equal(counts[key], 0, key);
}
/** Validate local inspection artifacts without resolving or fetching any identity. */
export function validateColdEvidence(raw: unknown, read: (path: string) => unknown, now = Date.now()): ColdEvidence {
  const manifest = object(raw);
  for (const key of ['oxySha', 'mentionSha']) if (!/^[0-9a-f]{40}$/.test(string(manifest[key]))) throw new Error('Invalid source SHA');
  for (const key of ['oxyDigest', 'mentionDigest']) if (!/^sha256:[0-9a-f]{64}$/.test(string(manifest[key]))) throw new Error('Invalid image digest');
  if (!Array.isArray(manifest.sources) || manifest.sources.length < 1 || manifest.sources.length > 2) throw new Error('Supply one or two source identities');
  const sources = manifest.sources.map((rawSource) => {
    const source = object(rawSource);
    const actorUri = string(source.actorUri);
    const url = new URL(actorUri);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Invalid actor URI');
    const canonicalAcct = string(source.canonicalAcct);
    const transportAcct = string(source.transportAcct);
    for (const acct of [canonicalAcct, transportAcct]) if (!/^[a-z0-9_][a-z0-9_.-]*@[a-z0-9][a-z0-9.-]+$/.test(acct)) throw new Error('Invalid source acct');
    const oxyRunReport = string(source.oxyRunReport);
    const oxySummaryReport = string(source.oxySummaryReport);
    const mentionReport = string(source.mentionReport);
    const oxyRun = object(read(oxyRunReport));
    const oxy = object(read(oxySummaryReport));
    const mention = object(read(mentionReport));
    for (const report of [oxyRun, oxy, mention]) equal(report.operation, 'inspect_cache', 'operation');
    for (const report of [oxyRun, mention]) {
      equal(report.dryRun, true, 'dryRun');
      const identifiers = object(report.identifiers);
      for (const [key, value] of Object.entries({ actorUri, canonicalAcct, transportAcct })) equal(identifiers[key], value, key);
    }
    equal(oxyRun.expectedSourceSha, manifest.oxySha, 'Oxy run SHA');
    equal(oxyRun.imageDigest, manifest.oxyDigest, 'Oxy run digest');
    equal(oxy.sourceSha, manifest.oxySha, 'Oxy SHA');
    equal(oxy.imageDigest, manifest.oxyDigest, 'Oxy digest');
    equal(mention.sourceSha, manifest.mentionSha, 'Mention SHA');
    equal(mention.imageDigest, manifest.mentionDigest, 'Mention digest');
    equal(mention.exitCode, 0, 'Mention exit code');
    equal(oxy.absent, true, 'Oxy absent');
    zeroes(oxy.counts, ['users', 'registryActors', 'registryIdentities']);
    zeroes(mention.report, ['actorUriMatches', 'canonicalAcctMatches', 'transportAcctMatches', 'postSourceMatches']);
    timestamp(oxy.observedAt, now);
    timestamp(mention.observedAt, now);
    return { actorUri, canonicalAcct, transportAcct, oxyRunReport, oxySummaryReport, mentionReport };
  });
  if (new Set(sources.map(source => source.actorUri)).size !== sources.length || new Set(sources.map(source => source.canonicalAcct)).size !== sources.length) throw new Error('Distinct source identities required');
  if (!Array.isArray(manifest.forbiddenBioText) || manifest.forbiddenBioText.length === 0) throw new Error('Supply reviewed bridge boilerplate to exclude');
  return {
    forbiddenBioText: manifest.forbiddenBioText.map(string),
    sources, oxySha: string(manifest.oxySha), oxyDigest: string(manifest.oxyDigest),
    mentionSha: string(manifest.mentionSha), mentionDigest: string(manifest.mentionDigest),
    expectedBioText: string(manifest.expectedBioText), expectedMentionLabel: string(manifest.expectedMentionLabel),
    expectedMentionHandle: string(manifest.expectedMentionHandle),
  };
}
export function loadColdEvidence(): ColdEvidence {
  if (process.env.MENTION_E2E_COLD_IDENTITY !== '1') throw new Error('Live cold gate requires explicit MENTION_E2E_COLD_IDENTITY=1');
  const file = resolve(string(process.env.MENTION_E2E_COLD_EVIDENCE));
  const read = (path: string): unknown => JSON.parse(readFileSync(resolve(file, '..', path), 'utf8'));
  return validateColdEvidence(JSON.parse(readFileSync(file, 'utf8')), read);
}

/** A static preview cannot prove the deployed server's public-profile boundary. */
export function validateColdAppOrigin(candidateOrigin: string, appOrigin: string): void {
  if (candidateOrigin !== appOrigin) {
    throw new Error('Cold acceptance must use the deployed app origin to exercise initial server HTML.');
  }
}
