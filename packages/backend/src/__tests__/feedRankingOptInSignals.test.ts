import { describe, it, expect, vi } from 'vitest';
import { MtnConfig } from '@mention/shared-types';

// Redis is unavailable in unit tests. Return a client whose connect() rejects
// with a recognized connection error so `withRedisFallback` degrades to its
// fallback (no cache) instead of throwing on the stub's missing methods.
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
 * PHASE 2b OPT-IN RANKING SIGNALS.
 *
 * Every signal here is default-NEUTRAL: its scorer returns exactly 1.0 when its
 * data is absent (the critical safety test), and it is applied by
 * `calculatePostScore` ONLY when the feed definition enables it via
 * `context.enabledSignals`. None are in any preset's signal set, so For You /
 * Explore / Videos / Media ranking is unchanged (guarded by the "off by default"
 * tests below + the engine parity/snapshot suite).
 */

const service = new FeedRankingService();
const R = MtnConfig.ranking.optInSignals;

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

/** Score a post with the engagement base pinned to 1 so opt-in factors are visible. */
async function scoreWith(
  post: Record<string, unknown>,
  context: Parameters<FeedRankingService['calculatePostScore']>[2] = {},
): Promise<number> {
  const engagementScoreCache = new Map<string, number>([[String(post._id), 1]]);
  return service.calculatePostScore(post, undefined, { ...context, engagementScoreCache });
}

/** A very old createdAt so recency-based signals see an "old" post. */
const OLD = new Date('2020-01-01T00:00:00Z');

describe('mediaBoost scorer', () => {
  it('is neutral (1.0) when the post carries no media', () => {
    expect(service.calculateMediaBoost(makePost())).toBe(1.0);
    expect(service.calculateMediaBoost(makePost({ content: { media: [] } }))).toBe(1.0);
  });

  it('boosts a post that carries media', () => {
    const withMedia = makePost({ content: { media: [{ id: 'm1' }] } });
    expect(service.calculateMediaBoost(withMedia)).toBe(R.mediaBoost.boost);
  });

  it('boosts an image/video post by type even without a media array', () => {
    expect(service.calculateMediaBoost(makePost({ type: 'image' }))).toBe(R.mediaBoost.boost);
    expect(service.calculateMediaBoost(makePost({ type: 'video' }))).toBe(R.mediaBoost.boost);
  });
});

describe('positivity scorer', () => {
  it('is neutral (1.0) when the post is not AI-classified (no provenance)', () => {
    expect(service.calculatePositivityBoost(makePost())).toBe(1.0);
    // sentiment present but status not classified → still neutral (no provenance).
    expect(
      service.calculatePositivityBoost(
        makePost({ postClassification: { status: 'baseline', topics: [], sentiment: 'positive' } }),
      ),
    ).toBe(1.0);
  });

  it('boosts a classified positive post', () => {
    const positive = makePost({ postClassification: { status: 'classified', topics: [], sentiment: 'positive' } });
    expect(service.calculatePositivityBoost(positive)).toBe(R.positivity.boost);
  });

  it('is neutral for classified neutral / negative / mixed posts', () => {
    for (const sentiment of ['neutral', 'negative', 'mixed'] as const) {
      const p = makePost({ postClassification: { status: 'classified', topics: [], sentiment } });
      expect(service.calculatePositivityBoost(p)).toBe(1.0);
    }
  });
});

describe('conversational scorer', () => {
  it('is neutral (1.0) when there is neither constructiveness nor reply signal', () => {
    expect(service.calculateConversationalBoost(makePost())).toBe(1.0);
  });

  it('boosts a classified high-constructiveness post, scaled and capped', () => {
    const high = makePost({
      postClassification: {
        status: 'classified',
        topics: [],
        scores: { toxicity: 0, constructiveness: 1, spam: 0, quality: 0.5, controversy: 0, negativity: 0 },
      },
    });
    expect(service.calculateConversationalBoost(high)).toBeCloseTo(R.conversational.maxBoost, 5);

    const half = makePost({
      postClassification: {
        status: 'classified',
        topics: [],
        scores: { toxicity: 0, constructiveness: 0.5, spam: 0, quality: 0.5, controversy: 0, negativity: 0 },
      },
    });
    expect(service.calculateConversationalBoost(half)).toBeCloseTo(1 + 0.5 * (R.conversational.maxBoost - 1), 5);
  });

  it('falls back to the reply ratio from stats when unclassified', () => {
    // 3 comments, 0 likes/boosts → reply ratio 1 → max boost.
    const replyHeavy = makePost({ stats: { likesCount: 0, boostsCount: 0, commentsCount: 3, viewsCount: 0 } });
    expect(service.calculateConversationalBoost(replyHeavy)).toBeCloseTo(R.conversational.maxBoost, 5);

    // Equal comments and likes → ratio 0.5.
    const mixed = makePost({ stats: { likesCount: 3, boostsCount: 0, commentsCount: 3, viewsCount: 0 } });
    expect(service.calculateConversationalBoost(mixed)).toBeCloseTo(1 + 0.5 * (R.conversational.maxBoost - 1), 5);
  });
});

describe('coldStartBoost scorer', () => {
  it('is neutral (1.0) for an old post whose author follower count is unknown', () => {
    expect(service.calculateColdStartBoost(makePost({ createdAt: OLD }), undefined)).toBe(1.0);
  });

  it('boosts a brand-new post', () => {
    expect(service.calculateColdStartBoost(makePost({ createdAt: new Date() }), 100000)).toBe(
      R.coldStartBoost.boost,
    );
  });

  it('boosts an old post from a low-follower (cold-start) author', () => {
    const belowThreshold = R.coldStartBoost.newAuthorFollowerThreshold - 1;
    expect(service.calculateColdStartBoost(makePost({ createdAt: OLD }), belowThreshold)).toBe(
      R.coldStartBoost.boost,
    );
  });

  it('is neutral for an old post from a well-followed author', () => {
    expect(service.calculateColdStartBoost(makePost({ createdAt: OLD }), 100000)).toBe(1.0);
  });
});

describe('opt-in signals are OFF unless the definition enables them (no regression)', () => {
  it('a media post scores identically with and without enabledSignals (mediaBoost off)', async () => {
    const media = makePost({ content: { media: [{ id: 'm1' }] } });
    const off = await scoreWith(media, {});
    const emptyEnabled = await scoreWith(media, { enabledSignals: new Set(['engagement', 'recency']) });
    expect(emptyEnabled).toBeCloseTo(off, 10);
  });

  it('enabling mediaBoost lifts a media post above the same post with it off', async () => {
    const media = makePost({ content: { media: [{ id: 'm1' }] } });
    const off = await scoreWith(media, {});
    const on = await scoreWith(media, { enabledSignals: new Set(['mediaBoost']) });
    expect(on / off).toBeCloseTo(R.mediaBoost.boost, 5);
  });

  it('enabling positivity lifts a classified positive post', async () => {
    const positive = makePost({ postClassification: { status: 'classified', topics: [], sentiment: 'positive' } });
    const off = await scoreWith(positive, {});
    const on = await scoreWith(positive, { enabledSignals: new Set(['positivity']) });
    expect(on / off).toBeCloseTo(R.positivity.boost, 5);
  });

  it('enabling coldStartBoost lifts a brand-new post', async () => {
    const fresh = makePost({ createdAt: new Date() });
    const off = await scoreWith(fresh, { authorFollowerCounts: new Map([['author-1', 100000]]) });
    const on = await scoreWith(fresh, {
      enabledSignals: new Set(['coldStartBoost']),
      authorFollowerCounts: new Map([['author-1', 100000]]),
    });
    expect(on / off).toBeCloseTo(R.coldStartBoost.boost, 5);
  });
});
