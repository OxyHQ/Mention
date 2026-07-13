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
import { curatorAuthority } from '../services/starterPackCuration';

/**
 * `starterPackBoost` — the RANKING side of starter-pack curation.
 *
 * The curation POLICY (which packs count, dedupe by curator, the score bound) is
 * covered in `services/starterPackCuration.test.ts`. This suite covers the scorer:
 * the score → multiplier map, its clamps, and the fact that it is inert unless the
 * feed definition enables it (so no other feed — and no golden master — moves).
 */

const service = new FeedRankingService();
const CURATION = MtnConfig.ranking.optInSignals.starterPackBoost;

function makePost(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: 'post-1',
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
  const engagementScoreCache = new Map<string, number>([[String(post._id), 1]]);
  return service.calculatePostScore(post, undefined, { ...context, engagementScoreCache });
}

/** The documented multiplier: `clamp(1 + scale · log1p(score), 1, maxBoost)`. */
function expectedMultiplier(score: number): number {
  return Math.min(CURATION.maxBoost, Math.max(1, 1 + CURATION.scale * Math.log1p(score)));
}

describe('starterPackBoost scorer', () => {
  it('is EXACTLY neutral for an uncurated author (never penalizes)', () => {
    expect(service.calculateStarterPackBoost(makePost(), new Map())).toBe(1.0);
    expect(
      service.calculateStarterPackBoost(makePost(), new Map([['someone-else', 10]])),
    ).toBe(1.0);
  });

  it('is EXACTLY neutral when the score map is absent (signal off / resolution failed)', () => {
    expect(service.calculateStarterPackBoost(makePost(), undefined)).toBe(1.0);
  });

  it('is EXACTLY neutral for a non-positive or non-finite score', () => {
    expect(service.calculateStarterPackBoost(makePost(), new Map([['author-1', 0]]))).toBe(1.0);
    expect(service.calculateStarterPackBoost(makePost(), new Map([['author-1', -3]]))).toBe(1.0);
    expect(service.calculateStarterPackBoost(makePost(), new Map([['author-1', Number.NaN]]))).toBe(1.0);
  });

  it('lifts a curated author, log-scaled in the curation score', () => {
    const small = service.calculateStarterPackBoost(makePost(), new Map([['author-1', 1]]));
    const large = service.calculateStarterPackBoost(makePost(), new Map([['author-1', 8]]));

    expect(small).toBeCloseTo(expectedMultiplier(1), 10);
    expect(large).toBeCloseTo(expectedMultiplier(8), 10);
    expect(large).toBeGreaterThan(small);
    // Log scale: 8× the score is nowhere near 8× the lift.
    expect(large - 1).toBeLessThan(8 * (small - 1));
  });

  it('is CLAMPED at `maxBoost` — curation can never run away with the score', () => {
    expect(service.calculateStarterPackBoost(makePost(), new Map([['author-1', CURATION.maxScore]]))).toBe(
      CURATION.maxBoost,
    );
    // Even an (impossible) score far above the policy's own clamp saturates.
    expect(service.calculateStarterPackBoost(makePost(), new Map([['author-1', 1_000_000]]))).toBe(
      CURATION.maxBoost,
    );
  });

  it('a low-follower curation RING earns a small lift; a real curator set earns the cap', () => {
    // Mirrors the policy suite: 3 zero-follower sybils with single-use packs.
    const ringScore = 3 * Math.log1p(1) * curatorAuthority(undefined);
    const ringBoost = service.calculateStarterPackBoost(makePost(), new Map([['author-1', ringScore]]));

    expect(ringBoost).toBeLessThan(1 + (CURATION.maxBoost - 1) * 0.5);

    const genuineBoost = service.calculateStarterPackBoost(
      makePost(),
      new Map([['author-1', CURATION.maxScore]]),
    );
    expect(ringBoost).toBeLessThan(genuineBoost);
  });
});

describe('starterPackBoost is OFF unless the definition enables it', () => {
  const curated = new Map([['author-1', CURATION.maxScore]]);

  it('a curated author scores identically when the signal is not enabled', async () => {
    const post = makePost();
    const off = await scoreWith(post, { authorStarterPackScores: curated });
    const otherEnabled = await scoreWith(post, {
      authorStarterPackScores: curated,
      enabledSignals: new Set(['engagement']),
    });

    expect(otherEnabled).toBeCloseTo(off, 10);
  });

  it('enabling starterPackBoost lifts a curated author by exactly the multiplier', async () => {
    const post = makePost();
    const off = await scoreWith(post, { authorStarterPackScores: curated });
    const on = await scoreWith(post, {
      authorStarterPackScores: curated,
      enabledSignals: new Set(['starterPackBoost']),
    });

    expect(on / off).toBeCloseTo(CURATION.maxBoost, 5);
  });

  it('enabling starterPackBoost does NOT touch an uncurated author', async () => {
    const post = makePost({ oxyUserId: 'uncurated-author' });
    const off = await scoreWith(post, { authorStarterPackScores: curated });
    const on = await scoreWith(post, {
      authorStarterPackScores: curated,
      enabledSignals: new Set(['starterPackBoost']),
    });

    expect(on / off).toBeCloseTo(1.0, 10);
  });

  it('is neutral when enabled but no scores were resolved (fail-soft feed still serves)', async () => {
    const post = makePost();
    const off = await scoreWith(post, {});
    const on = await scoreWith(post, { enabledSignals: new Set(['starterPackBoost']) });

    expect(on / off).toBeCloseTo(1.0, 10);
  });
});
