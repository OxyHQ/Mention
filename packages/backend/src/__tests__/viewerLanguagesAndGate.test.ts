import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { CachedUserSummary } from '../services/userSummaryCache';

/**
 * Viewer-language resolution, and the For You discovery gate.
 *
 * TWO language helpers, answering two different questions in two different units
 * — see the `resolveViewerBaseLanguages` block below for why conflating them is
 * a bug and not a tidiness point:
 *
 *   - `loadViewerLanguages` — the VIEWER's Oxy account locales (canonical BCP-47,
 *     primary first, REGION-SIGNIFICANT), read through the Redis-cached identity
 *     path the feed already uses for post authors, so it adds no new Oxy round
 *     trip and soft-fails to `[]` on any miss or error.
 *   - `resolveViewerBaseLanguages` — the READABILITY set (ISO 639-1 base subtags,
 *     region discarded, capped), resolved from the account else the request. This
 *     is the boundary where every language input is normalized and every bad one
 *     is dropped, which is what lets the SQL predicate and the ranking signals
 *     downstream trust what they are handed.
 *
 * `resolveDiscoveryGate` maps the `FOR_YOU_DISCOVERY_GATE` env flag onto the For
 * You discovery-gate filter set.
 */

const { resolveUserSummaries } = vi.hoisted(() => ({ resolveUserSummaries: vi.fn() }));

// The identity path `loadViewerLanguages` reuses. Mocked so this suite asserts
// the CONTRACT (cached locales in, fail-soft out) without Redis or Oxy — and so
// importing feedContext stays free of the hydration module's dependency chain.
vi.mock('../services/PostHydrationService', () => ({ resolveUserSummaries }));

import { loadViewerLanguages, resolveViewerBaseLanguages } from '../mtn/feed/feedContext';
import { resolveDiscoveryGate } from '../mtn/feed/definitions/presets';

/** A cached identity carrying the account's canonical locales. */
function summaryWith(userId: string, languages?: string[]): CachedUserSummary {
  return {
    user: { id: userId, username: 'viewer', name: { displayName: 'Viewer' } },
    languages,
  };
}

describe('loadViewerLanguages', () => {
  const viewerId = 'viewer-1';

  beforeEach(() => {
    resolveUserSummaries.mockReset();
  });

  it('returns the viewer\'s account locales, primary first', async () => {
    resolveUserSummaries.mockResolvedValue(
      new Map([[viewerId, summaryWith(viewerId, ['es-ES', 'en-US'])]]),
    );

    await expect(loadViewerLanguages(viewerId)).resolves.toEqual(['es-ES', 'en-US']);
    expect(resolveUserSummaries).toHaveBeenCalledWith([viewerId]);
  });

  it('returns [] for an anonymous viewer WITHOUT touching the identity path', async () => {
    await expect(loadViewerLanguages(undefined)).resolves.toEqual([]);
    expect(resolveUserSummaries).not.toHaveBeenCalled();
  });

  it('returns [] when the account declares no languages', async () => {
    resolveUserSummaries.mockResolvedValue(new Map([[viewerId, summaryWith(viewerId)]]));
    await expect(loadViewerLanguages(viewerId)).resolves.toEqual([]);
  });

  it('returns [] when the viewer cannot be resolved', async () => {
    resolveUserSummaries.mockResolvedValue(new Map<string, CachedUserSummary>());
    await expect(loadViewerLanguages(viewerId)).resolves.toEqual([]);
  });

  it('is FAIL-SOFT: a lookup error degrades to [] (neutral penalty), never throws', async () => {
    resolveUserSummaries.mockRejectedValue(new Error('oxy unreachable'));
    await expect(loadViewerLanguages(viewerId)).resolves.toEqual([]);
  });
});

/**
 * The reader's READABILITY set — which languages they can read at all.
 *
 * Separate from `loadViewerLanguages` on purpose, and the separation is
 * load-bearing rather than cosmetic. `loadViewerLanguages` answers "which
 * RENDITION of this post do I show?", which hydration resolves through
 * `selectVariantForTag` — that matches the EXACT locale before the base subtag,
 * so `pt-BR` and `pt-PT` are genuinely different answers and the region must
 * survive. This answers "can this reader read this post AT ALL?", where the
 * region is noise and must not cause a false mismatch.
 *
 * This is also the single place garbage is dropped, which is why the ranking
 * signals downstream trust their input and do not re-normalize it.
 */
describe('resolveViewerBaseLanguages', () => {
  it('reduces account locales to their base subtag, order preserved', () => {
    expect(resolveViewerBaseLanguages(['es-ES', 'en-US'], [])).toEqual(['es', 'en']);
  });

  it('falls back to the REQUEST when the account declares nothing', () => {
    expect(resolveViewerBaseLanguages([], ['es-ES', 'en'])).toEqual(['es', 'en']);
  });

  /**
   * The anonymous case, which is the one the whole change exists for: a
   * signed-out reader has no account, so the request is their only declaration.
   * Before this, `viewerLanguages` was `[]` for every logged-out reader and every
   * language-conditional path went neutral — measured on production, that feed
   * came back 48% `de` against a 6.8%-`de` corpus.
   */
  it('resolves an anonymous reader from the request alone', () => {
    expect(resolveViewerBaseLanguages([], ['de-DE'])).toEqual(['de']);
  });

  it('prefers the ACCOUNT over the request when both are present', () => {
    expect(resolveViewerBaseLanguages(['es-ES'], ['de-DE'])).toEqual(['es']);
  });

  it('de-duplicates locales that share a base subtag', () => {
    expect(resolveViewerBaseLanguages(['es-ES', 'es-MX', 'en-GB'], [])).toEqual(['es', 'en']);
  });

  /**
   * `Accept-Language` is attacker-controlled and unbounded. The cap bounds two
   * things at once: the width of the `&&` array overlap on every discovery lane,
   * and the cardinality of the anonymous feed cache, whose key now carries this
   * set.
   */
  it('caps the set at three', () => {
    expect(resolveViewerBaseLanguages([], ['es', 'en', 'de', 'fr', 'ja'])).toEqual(['es', 'en', 'de']);
  });

  /**
   * Garbage drops out HERE, so no consumer has to defend against it. An entry
   * that survived would not merely be ignored — it would fail to match every
   * post, which for a hard SQL predicate means an empty feed.
   */
  it('drops unparseable entries rather than passing them through', () => {
    expect(resolveViewerBaseLanguages([], ['', '   ', 'not-a-language-tag'])).toEqual([]);
    expect(resolveViewerBaseLanguages([], ['', 'es-ES'])).toEqual(['es']);
  });

  it('is [] when neither side declares anything (an UNKNOWN reader, never a filtered one)', () => {
    expect(resolveViewerBaseLanguages([], [])).toEqual([]);
  });
});

describe('resolveDiscoveryGate', () => {
  const original = process.env.FOR_YOU_DISCOVERY_GATE;
  afterEach(() => {
    if (original === undefined) delete process.env.FOR_YOU_DISCOVERY_GATE;
    else process.env.FOR_YOU_DISCOVERY_GATE = original;
  });

  const ids = (refs: ReturnType<typeof resolveDiscoveryGate>) => refs.map((r) => r.module);

  it('defaults to the full gate when unset', () => {
    delete process.env.FOR_YOU_DISCOVERY_GATE;
    // Phase 4B adds `minQuality` — NEUTRAL by default (opt-in via feedTuning), so
    // it changes nothing unless a viewer sets a threshold in For You settings.
    expect(ids(resolveDiscoveryGate())).toEqual(['minLength', 'lowEffortGate', 'nativeEngagement', 'minQuality']);
  });

  it('stamps the `forYouGate` marker on every gate ref', () => {
    delete process.env.FOR_YOU_DISCOVERY_GATE;
    expect(resolveDiscoveryGate().every((r) => r.params?.forYouGate === true)).toBe(true);
  });

  it('is empty when explicitly off', () => {
    process.env.FOR_YOU_DISCOVERY_GATE = 'off';
    expect(resolveDiscoveryGate()).toEqual([]);
  });

  it('accepts a validated explicit subset', () => {
    process.env.FOR_YOU_DISCOVERY_GATE = 'lowEffortGate,nativeEngagement';
    expect(ids(resolveDiscoveryGate())).toEqual(['lowEffortGate', 'nativeEngagement']);
  });

  it('rejects unknown gate ids instead of silently dropping them', () => {
    process.env.FOR_YOU_DISCOVERY_GATE = 'lowEffortGate,bogus';
    expect(() => resolveDiscoveryGate()).toThrow('FOR_YOU_DISCOVERY_GATE');
  });

  it('injects the minLength threshold from config', () => {
    delete process.env.FOR_YOU_DISCOVERY_GATE;
    const minLength = resolveDiscoveryGate().find((r) => r.module === 'minLength');
    expect(minLength?.params?.minLength).toBeTypeOf('number');
  });
});
