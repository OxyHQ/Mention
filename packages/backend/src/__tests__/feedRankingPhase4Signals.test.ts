import { describe, it, expect, vi } from 'vitest';
import { MtnConfig } from '@mention/shared-types';

// Redis is unavailable in unit tests — degrade the cache to a no-op (see the
// other ranking suites for the identical stub).
vi.mock('../utils/redis', () => ({
  getRedisClient: vi.fn().mockReturnValue({
    isReady: false,
    isOpen: false,
    connect: vi.fn().mockRejectedValue(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' })),
    ping: vi.fn().mockRejectedValue(new Error('not connected')),
    get: vi.fn(),
    set: vi.fn(),
    setEx: vi.fn(),
    del: vi.fn(),
  }),
}));

import { FeedRankingService } from '../services/FeedRankingService';

/**
 * PHASE 4 DISCOVERY RANKING SIGNALS — `localBoost` (4d) and
 * `languageMismatchPenalty` (4c).
 *
 * Both are DORMANT opt-in signals: default-neutral, applied ONLY when the feed
 * definition enables them (Phase 5 adds them to the For You default set). These
 * assert (a) the scorer semantics directly and (b) that they are OFF unless
 * enabled — so preset ranking (and the golden master) is unchanged.
 */

const service = new FeedRankingService();
const R = MtnConfig.ranking.optInSignals;

function makePost(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'post-1',
    oxyUserId: 'author-1',
    createdAt: new Date(),
    type: 'text',
    hashtags: [],
    stats: { likesCount: 0, boostsCount: 0, commentsCount: 0, viewsCount: 0 },
    metadata: {},
    ...overrides,
  };
}

async function scoreWith(
  post: Record<string, unknown>,
  context: Parameters<FeedRankingService['calculatePostScore']>[2] = {},
): Promise<number> {
  const engagementScoreCache = new Map<string, number>([[String(post.id), 1]]);
  return service.calculatePostScore(post, undefined, { ...context, engagementScoreCache });
}

describe('localBoost scorer', () => {
  it('boosts a LOCAL post (federation absent or null)', () => {
    expect(service.calculateLocalBoost(makePost())).toBe(R.localBoost.boost);
    expect(service.calculateLocalBoost(makePost({ federation: null }))).toBe(R.localBoost.boost);
  });

  it('is neutral (1.0) for a FEDERATED post', () => {
    expect(service.calculateLocalBoost(makePost({ federation: { actorUri: 'https://x/u/1' } }))).toBe(1.0);
  });
});

describe('languageMismatchPenalty scorer', () => {
  const discovery = (langs: string[]) =>
    makePost({ _discovery: true, postClassification: { languages: langs } });

  it('is neutral for a NON-discovery post even when off-language', () => {
    const trusted = makePost({ postClassification: { languages: ['de'] } }); // no _discovery
    expect(service.calculateLanguageMismatchPenalty(trusted, ['en'])).toBe(1.0);
  });

  it('is neutral when the viewer has no known languages', () => {
    expect(service.calculateLanguageMismatchPenalty(discovery(['de']), undefined)).toBe(1.0);
    expect(service.calculateLanguageMismatchPenalty(discovery(['de']), [])).toBe(1.0);
  });

  it('is neutral when the post declares no language', () => {
    expect(service.calculateLanguageMismatchPenalty(makePost({ _discovery: true }), ['en'])).toBe(1.0);
    expect(service.calculateLanguageMismatchPenalty(discovery([]), ['en'])).toBe(1.0);
  });

  it('is neutral when languages OVERLAP (case-insensitive)', () => {
    expect(service.calculateLanguageMismatchPenalty(discovery(['en', 'de']), ['en'])).toBe(1.0);
    expect(service.calculateLanguageMismatchPenalty(discovery(['EN']), ['en'])).toBe(1.0);
  });

  it('penalizes an off-language DISCOVERY post whose languages are disjoint', () => {
    expect(service.calculateLanguageMismatchPenalty(discovery(['de']), ['en'])).toBe(
      R.languageMismatchPenalty.penalty,
    );
    expect(service.calculateLanguageMismatchPenalty(discovery(['fr']), ['en', 'es'])).toBe(
      R.languageMismatchPenalty.penalty,
    );
  });

  /**
   * The viewer side arrives ALREADY normalized to ISO 639-1 base subtags —
   * `loadViewerFeedContext` does it once, at the boundary, so `ctx.viewerLanguages`
   * is in the same unit as `postClassification.languages` and the SQL predicate
   * that shares it can be a plain array overlap. (That normalization is pinned in
   * `viewerLanguagesAndGate.test.ts`, where it now happens.)
   *
   * The POST side still needs normalizing here: a federated declaration can carry
   * a region (`pt-BR`), so region must never cause a false mismatch.
   */
  describe('the POST side is matched on the BASE subtag', () => {
    const viewer = ['es', 'en'];

    it('is neutral for a post in a language the viewer speaks (any region)', () => {
      expect(service.calculateLanguageMismatchPenalty(discovery(['es']), viewer)).toBe(1.0);
      expect(service.calculateLanguageMismatchPenalty(discovery(['en']), viewer)).toBe(1.0);
      expect(service.calculateLanguageMismatchPenalty(discovery(['de', 'en']), viewer)).toBe(1.0);
    });

    it('ignores a region on the POST — an `es` viewer still matches an `es-MX` post', () => {
      expect(service.calculateLanguageMismatchPenalty(discovery(['es-MX']), ['es'])).toBe(1.0);
      expect(service.calculateLanguageMismatchPenalty(discovery(['pt-BR']), ['pt'])).toBe(1.0);
    });

    it('penalizes a genuinely foreign language', () => {
      for (const language of ['de', 'ja', 'fr']) {
        expect(service.calculateLanguageMismatchPenalty(discovery([language]), viewer)).toBe(
          R.languageMismatchPenalty.penalty,
        );
      }
    });

    /**
     * "Unknown" is the neutral case on both sides. Garbage on the VIEWER side is
     * not tested here because it cannot reach here: `resolveViewerBaseLanguages`
     * runs every entry through `toBaseLanguages` at the boundary, so `['', '  ']`
     * arrives as `[]` and lands on the empty check below. That normalization is
     * pinned in `viewerLanguagesAndGate.test.ts`, where it happens.
     */
    it('stays neutral when either side is unknown', () => {
      expect(service.calculateLanguageMismatchPenalty(discovery(['de']), [])).toBe(1.0);
      expect(service.calculateLanguageMismatchPenalty(discovery([]), viewer)).toBe(1.0);
      expect(service.calculateLanguageMismatchPenalty(makePost({ _discovery: true }), viewer)).toBe(1.0);
    });

  });
});

describe('Phase 4 signals are OFF unless the definition enables them', () => {
  it('a local post scores identically with the signal off', async () => {
    const local = makePost({ federation: null });
    const off = await scoreWith(local, {});
    const otherEnabled = await scoreWith(local, { enabledSignals: new Set(['engagement']) });
    expect(otherEnabled).toBeCloseTo(off, 10);
  });

  it('enabling localBoost lifts a local post', async () => {
    const local = makePost({ federation: null });
    const off = await scoreWith(local, {});
    const on = await scoreWith(local, { enabledSignals: new Set(['localBoost']) });
    expect(on / off).toBeCloseTo(R.localBoost.boost, 5);
  });

  it('enabling localBoost does NOT lift a federated post', async () => {
    const federated = makePost({ federation: { actorUri: 'https://x/u/1' } });
    const off = await scoreWith(federated, {});
    const on = await scoreWith(federated, { enabledSignals: new Set(['localBoost']) });
    expect(on / off).toBeCloseTo(1.0, 5);
  });

  it('enabling languageMismatchPenalty downranks an off-language discovery post', async () => {
    const offLang = makePost({ _discovery: true, postClassification: { languages: ['de'] } });
    const off = await scoreWith(offLang, { viewerLanguages: ['en'] });
    const on = await scoreWith(offLang, {
      enabledSignals: new Set(['languageMismatchPenalty']),
      viewerLanguages: ['en'],
    });
    expect(on / off).toBeCloseTo(R.languageMismatchPenalty.penalty, 5);
  });

  it('enabling languageMismatchPenalty does NOT touch a trusted (non-discovery) off-language post', async () => {
    const trustedOffLang = makePost({ postClassification: { languages: ['de'] } });
    const off = await scoreWith(trustedOffLang, { viewerLanguages: ['en'] });
    const on = await scoreWith(trustedOffLang, {
      enabledSignals: new Set(['languageMismatchPenalty']),
      viewerLanguages: ['en'],
    });
    expect(on / off).toBeCloseTo(1.0, 5);
  });
});
