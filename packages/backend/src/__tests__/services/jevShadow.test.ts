import { describe, expect, it } from 'vitest';
import {
  isJevShadowReleased, JEV_SHADOW_BLOCKERS, shadowAbstention, shadowFingerprint,
  shadowSignalsSchema, validateShadowRelease, type ShadowRelease, type ShadowSnapshot,
} from '../../services/contentClassification/jevShadow';

const release: ShadowRelease = {
  model: 'synthetic/jev@fixture-revision-1', policyRef: 'synthetic-policy',
  policyVersion: 1, evaluationVersion: 'shadow-v1', supportedLanguages: ['en'],
};
const snapshot: ShadowSnapshot = {
  postId: 'synthetic-post', actorUri: 'https://actor.example/users/original', owner: null,
  languages: ['en'], renditions: [{
    id: 'rendition-1', position: 0, source: 'author', tag: 'en', body: 'a'.repeat(1100),
    articleTitle: null, articleBody: null, articleExcerpt: null,
  }],
};

describe('Jev shadow policy', () => {
  it('keeps SDK, exact release, eligibility and privacy/ZDR gates closed', () => {
    expect(isJevShadowReleased()).toBe(false);
    expect(JEV_SHADOW_BLOCKERS).toEqual([
      'published_decisions_sdk', 'reviewed_exact_model_and_oxy_policy',
      'internal_provider_eligibility', 'privacy_and_zdr',
    ]);
  });

  it('fingerprints changes beyond the 1000 characters sent to inference', () => {
    const edited = { ...snapshot, renditions: snapshot.renditions.map(row => ({ ...row, body: `${row.body}b` })) };
    expect(edited.renditions[0]?.body.slice(0, 1000)).toBe(snapshot.renditions[0]?.body.slice(0, 1000));
    expect(shadowFingerprint(edited)).not.toBe(shadowFingerprint(snapshot));
  });

  it('distinguishes replacement renditions with identical text and changed actor/language', () => {
    expect(shadowFingerprint({ ...snapshot, renditions: snapshot.renditions.map(row => ({ ...row, id: 'revision-2' })) }))
      .not.toBe(shadowFingerprint(snapshot));
    expect(shadowFingerprint({ ...snapshot, actorUri: 'did:plc:other' })).not.toBe(shadowFingerprint(snapshot));
    expect(shadowFingerprint({ ...snapshot, languages: ['es'] })).not.toBe(shadowFingerprint(snapshot));
  });

  it('does not fingerprint engagement timestamps or incidental property ordering', () => {
    const withUpdatedAt = { ...snapshot, updatedAt: new Date() };
    expect(shadowFingerprint(withUpdatedAt)).toBe(shadowFingerprint(snapshot));
    const reordered = { renditions: snapshot.renditions, languages: snapshot.languages,
      owner: snapshot.owner, actorUri: snapshot.actorUri, postId: snapshot.postId };
    expect(shadowFingerprint(reordered)).toBe(shadowFingerprint(snapshot));
  });

  it('abstains on media-only, unknown, unsupported and mixed unsupported languages', () => {
    expect(shadowAbstention({ ...snapshot, renditions: [] }, release)).toBe('no_primary_text');
    expect(shadowAbstention({ ...snapshot, languages: [] }, release)).toBe('unknown_language');
    expect(shadowAbstention({ ...snapshot, languages: ['ja'] }, release)).toBe('unsupported_language');
    expect(shadowAbstention({ ...snapshot, languages: ['en', 'ja'] }, release)).toBe('unsupported_language');
    expect(shadowAbstention(snapshot, release)).toBeNull();
  });

  it('keeps overlapping topics, spam, repetition and feed value independent', () => {
    const signals = { topics: [{ topic: 'science', probability: 0.9 }, { topic: 'news', probability: 0.9 }],
      languages: ['en'], spam: 0.1, repetition: 0.8, feedValue: 0.7 };
    expect(shadowSignalsSchema.parse(signals)).toEqual(signals);
    expect(shadowSignalsSchema.safeParse({ ...signals, spam: NaN }).success).toBe(false);
    expect(shadowSignalsSchema.safeParse({ ...signals, topics: [signals.topics[0], signals.topics[0]] }).success).toBe(false);
    expect(shadowSignalsSchema.safeParse({ ...signals, confidence: 0.9 }).success).toBe(false);
  });

  it('refuses mutable model aliases and missing version identity', () => {
    expect(() => validateShadowRelease(release)).not.toThrow();
    for (const model of ['auto', 'synthetic/jev', 'synthetic/jev@latest', 'synthetic/jev@main']) {
      expect(() => validateShadowRelease({ ...release, model })).toThrow(/immutable/);
    }
    expect(() => validateShadowRelease({ ...release, policyVersion: 0 })).toThrow(/immutable/);
    expect(() => validateShadowRelease({ ...release, evaluationVersion: '' })).toThrow(/immutable/);
  });
});
