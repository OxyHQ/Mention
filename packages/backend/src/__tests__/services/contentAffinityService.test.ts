import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  likeFind: vi.fn(),
  postFind: vi.fn(),
  postAggregate: vi.fn(),
  entityFollowFind: vi.fn(),
  userBehaviorFindOne: vi.fn(),
  userSettingsFind: vi.fn(),
  getFollowingIdSet: vi.fn(),
  blockFind: vi.fn(),
  muteFind: vi.fn(),
  restrictFind: vi.fn(),
  getRedisClient: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
}));

vi.mock('../../models/Like', () => ({ default: { find: mocks.likeFind } }));
vi.mock('../../models/Post', () => ({ Post: { find: mocks.postFind, aggregate: mocks.postAggregate } }));
vi.mock('../../models/EntityFollow', () => ({ EntityFollow: { find: mocks.entityFollowFind } }));
vi.mock('../../models/UserBehavior', () => ({ default: { findOne: mocks.userBehaviorFindOne } }));
vi.mock('../../models/UserSettings', () => ({ default: { find: mocks.userSettingsFind } }));
vi.mock('../../models/Block', () => ({ default: { find: mocks.blockFind } }));
vi.mock('../../models/Mute', () => ({ default: { find: mocks.muteFind } }));
vi.mock('../../models/Restrict', () => ({ default: { find: mocks.restrictFind } }));

vi.mock('../../utils/redis', () => ({
  getRedisClient: mocks.getRedisClient,
}));
vi.mock('../../utils/privacyHelpers', () => ({
  ProfileVisibility: { PUBLIC: 'public', PRIVATE: 'private', FOLLOWERS_ONLY: 'followers_only' },
  requiresAccessCheck: (visibility: string | undefined) => visibility === 'private' || visibility === 'followers_only',
  getFollowingIdSet: mocks.getFollowingIdSet,
}));

// The authority blend dynamically imports these; stub them so the blend is a
// deterministic NEUTRAL no-op (every candidate gets multiplier 1.0). This
// isolates the surface-discount assertions from follower-count resolution.
vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock('../../services/FeedRankingService', () => ({
  feedRankingService: { calculateAuthorityScore: vi.fn().mockReturnValue(1.0) },
}));

import { ContentAffinityService } from '../../services/ContentAffinityService';

/** Build a chainable lean-find mock supporting .limit().sort().lean(). */
function leanQuery(rows: unknown[]) {
  const chain = {
    limit: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(rows),
  };
  return vi.fn().mockReturnValue(chain);
}

/** Build a `findOne().lean()` mock returning a single (or null) document. */
function leanFindOne(doc: unknown) {
  return vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(doc) });
}

/** Default: empty exclusion relations. */
function emptyExclusions(): void {
  mocks.blockFind.mockImplementation(leanQuery([]));
  mocks.muteFind.mockImplementation(leanQuery([]));
  mocks.restrictFind.mockImplementation(leanQuery([]));
}

/** Default: no signals at all (empty everything). */
function noSignals(): void {
  mocks.entityFollowFind.mockImplementation(leanQuery([]));
  mocks.postAggregate.mockResolvedValue([]);
  mocks.likeFind.mockImplementation(leanQuery([]));
  mocks.postFind.mockImplementation(leanQuery([]));
  // No maintained behavior aggregate by default (cold viewer) → preferred-author,
  // topic-affinity, and negative-signal inputs all run empty.
  mocks.userBehaviorFindOne.mockImplementation(leanFindOne(null));
  mocks.userSettingsFind.mockImplementation(leanQuery([]));
  mocks.getFollowingIdSet.mockResolvedValue(new Set());
}

beforeEach(() => {
  vi.clearAllMocks();
  // Redis disabled by default → no cache (miss + no write).
  mocks.getRedisClient.mockReturnValue({ isReady: false, get: mocks.redisGet, set: mocks.redisSet });
  emptyExclusions();
  noSignals();
});

function makeService() {
  return new ContentAffinityService();
}

describe('ContentAffinityService.getContentCandidates', () => {
  it('returns [] when the viewer has no followed hashtags and no engagement', async () => {
    const service = makeService();
    const result = await service.getContentCandidates('viewer_1');
    expect(result).toEqual([]);
  });

  it('returns [] when viewerId is empty', async () => {
    const service = makeService();
    const result = await service.getContentCandidates('');
    expect(result).toEqual([]);
    expect(mocks.entityFollowFind).not.toHaveBeenCalled();
  });

  it('hashtag affinity picks authors posting under followed tags', async () => {
    mocks.entityFollowFind.mockImplementation(leanQuery([{ entityId: 'rust' }, { entityId: 'go' }]));
    // Author a1 covers both followed tags; a2 covers one.
    mocks.postAggregate.mockResolvedValue([
      { _id: 'a1', matchedTags: [['rust'], ['go']], postCount: 4 },
      { _id: 'a2', matchedTags: [['rust']], postCount: 1 },
    ]);

    const service = makeService();
    const result = await service.getContentCandidates('viewer_1');

    const ids = result.map((c) => c.userId);
    expect(ids).toContain('a1');
    expect(ids).toContain('a2');
    // a1 covers two distinct followed tags → strictly higher weight than a2.
    const a1 = result.find((c) => c.userId === 'a1');
    const a2 = result.find((c) => c.userId === 'a2');
    expect(a1?.weight).toBeGreaterThan(a2?.weight ?? 0);
    expect(a1?.reasons).toContain('hashtag');
  });

  it('engagement affinity picks authors of liked, replied, and boosted posts', async () => {
    // Viewer liked post p_like (author author_like).
    mocks.likeFind.mockImplementation(leanQuery([{ postId: 'p_like' }]));
    // Viewer's own posts: a reply targeting p_reply, a boost of p_boost.
    mocks.postFind.mockImplementation((match: Record<string, unknown>) => {
      if (match.type === 'boost') return leanQuery([{ boostOf: 'p_boost' }])();
      if (match.parentPostId) return leanQuery([{ parentPostId: 'p_reply' }])();
      // The batched author-resolution query (find by _id $in).
      return leanQuery([
        { _id: 'p_like', oxyUserId: 'author_like' },
        { _id: 'p_reply', oxyUserId: 'author_reply' },
        { _id: 'p_boost', oxyUserId: 'author_boost' },
      ])();
    });

    const service = makeService();
    const result = await service.getContentCandidates('viewer_1');

    const ids = result.map((c) => c.userId);
    expect(ids).toEqual(expect.arrayContaining(['author_like', 'author_reply', 'author_boost']));
    for (const c of result) {
      expect(c.reasons).toContain('engagement');
    }
    // Boost is weighted highest, then reply, then like.
    const like = result.find((c) => c.userId === 'author_like')?.weight ?? 0;
    const reply = result.find((c) => c.userId === 'author_reply')?.weight ?? 0;
    const boost = result.find((c) => c.userId === 'author_boost')?.weight ?? 0;
    expect(boost).toBeGreaterThan(reply);
    expect(reply).toBeGreaterThan(like);
  });

  it('discounts a video-surface like vs a normal-surface like for AUTHOR candidates', async () => {
    // Two authors, each engaged via exactly one like. author_normal's like came
    // from the home feed (full author weight); author_video's like came from the
    // reels surface (source='videos' → discounted author weight). The video like
    // must yield a STRICTLY LOWER author-candidate weight.
    mocks.likeFind.mockImplementation(leanQuery([
      { postId: 'p_normal', source: 'for_you' },
      { postId: 'p_video', source: 'videos' },
    ]));
    mocks.postFind.mockImplementation((match: Record<string, unknown>) => {
      if (match.type === 'boost') return leanQuery([])();
      if (match.parentPostId) return leanQuery([])();
      return leanQuery([
        { _id: 'p_normal', oxyUserId: 'author_normal' },
        { _id: 'p_video', oxyUserId: 'author_video' },
      ])();
    });

    const service = makeService();
    const result = await service.getContentCandidates('viewer_1');

    const normal = result.find((c) => c.userId === 'author_normal')?.weight ?? 0;
    const video = result.find((c) => c.userId === 'author_video')?.weight ?? 0;
    expect(normal).toBeGreaterThan(0);
    expect(video).toBeGreaterThan(0);
    expect(video).toBeLessThan(normal);
  });

  it('treats a like with no source (legacy) as a full-weight, non-video like', async () => {
    mocks.likeFind.mockImplementation(leanQuery([
      { postId: 'p_legacy' }, // no `source`
      { postId: 'p_video', source: 'videos' },
    ]));
    mocks.postFind.mockImplementation((match: Record<string, unknown>) => {
      if (match.type === 'boost') return leanQuery([])();
      if (match.parentPostId) return leanQuery([])();
      return leanQuery([
        { _id: 'p_legacy', oxyUserId: 'author_legacy' },
        { _id: 'p_video', oxyUserId: 'author_video' },
      ])();
    });

    const service = makeService();
    const result = await service.getContentCandidates('viewer_1');

    const legacy = result.find((c) => c.userId === 'author_legacy')?.weight ?? 0;
    const video = result.find((c) => c.userId === 'author_video')?.weight ?? 0;
    // Legacy (no source) keeps the full like weight; video is discounted below it.
    expect(video).toBeLessThan(legacy);
  });

  it('engagement affinity outranks hashtag affinity for the same author', async () => {
    mocks.entityFollowFind.mockImplementation(leanQuery([{ entityId: 'rust' }]));
    // Hashtag author hOnly; engaged author both via like.
    mocks.postAggregate.mockResolvedValue([
      { _id: 'hOnly', matchedTags: [['rust']], postCount: 1 },
    ]);
    mocks.likeFind.mockImplementation(leanQuery([{ postId: 'p1' }]));
    mocks.postFind.mockImplementation((match: Record<string, unknown>) => {
      if (match.type === 'boost') return leanQuery([])();
      if (match.parentPostId) return leanQuery([])();
      return leanQuery([{ _id: 'p1', oxyUserId: 'engaged' }])();
    });

    const service = makeService();
    const result = await service.getContentCandidates('viewer_1');

    const engaged = result.find((c) => c.userId === 'engaged')?.weight ?? 0;
    const hOnly = result.find((c) => c.userId === 'hOnly')?.weight ?? 0;
    expect(engaged).toBeGreaterThan(hOnly);
  });

  it('merges signals for an author hit by both hashtag and engagement', async () => {
    mocks.entityFollowFind.mockImplementation(leanQuery([{ entityId: 'rust' }]));
    mocks.postAggregate.mockResolvedValue([
      { _id: 'both', matchedTags: [['rust']], postCount: 2 },
    ]);
    mocks.likeFind.mockImplementation(leanQuery([{ postId: 'p1' }]));
    mocks.postFind.mockImplementation((match: Record<string, unknown>) => {
      if (match.type === 'boost') return leanQuery([])();
      if (match.parentPostId) return leanQuery([])();
      return leanQuery([{ _id: 'p1', oxyUserId: 'both' }])();
    });

    const service = makeService();
    const result = await service.getContentCandidates('viewer_1');

    const both = result.find((c) => c.userId === 'both');
    expect(both).toBeDefined();
    expect(both?.reasons).toEqual(expect.arrayContaining(['engagement', 'hashtag']));
  });

  it('excludes self and blocked/muted/restricted users', async () => {
    mocks.blockFind.mockImplementation(leanQuery([{ blockedId: 'blocked_1' }]));
    mocks.muteFind.mockImplementation(leanQuery([{ mutedId: 'muted_1' }]));
    mocks.restrictFind.mockImplementation(leanQuery([{ restrictedId: 'restricted_1' }]));
    mocks.entityFollowFind.mockImplementation(leanQuery([{ entityId: 'rust' }]));
    mocks.postAggregate.mockResolvedValue([
      { _id: 'blocked_1', matchedTags: [['rust']], postCount: 1 },
      { _id: 'muted_1', matchedTags: [['rust']], postCount: 1 },
      { _id: 'restricted_1', matchedTags: [['rust']], postCount: 1 },
      { _id: 'viewer_1', matchedTags: [['rust']], postCount: 1 },
      { _id: 'good', matchedTags: [['rust']], postCount: 1 },
    ]);

    const service = makeService();
    const result = await service.getContentCandidates('viewer_1');

    const ids = result.map((c) => c.userId);
    expect(ids).toEqual(['good']);
  });

  it('filters private and followers-only profile candidates unless the viewer follows them', async () => {
    mocks.entityFollowFind.mockImplementation(leanQuery([{ entityId: 'rust' }]));
    mocks.postAggregate.mockResolvedValue([
      { _id: 'public_author', matchedTags: [['rust']], postCount: 1 },
      { _id: 'private_author', matchedTags: [['rust']], postCount: 1 },
      { _id: 'followers_author', matchedTags: [['rust']], postCount: 1 },
      { _id: 'followed_private_author', matchedTags: [['rust']], postCount: 1 },
    ]);
    mocks.userSettingsFind.mockImplementation(leanQuery([
      { oxyUserId: 'private_author', privacy: { profileVisibility: 'private' } },
      { oxyUserId: 'followers_author', privacy: { profileVisibility: 'followers_only' } },
      { oxyUserId: 'followed_private_author', privacy: { profileVisibility: 'private' } },
    ]));
    mocks.getFollowingIdSet.mockImplementation(
      async (_viewerId: string) => new Set(['followed_private_author']),
    );

    const service = makeService();
    const result = await service.getContentCandidates('viewer_1');

    expect(result.map((c) => c.userId).sort()).toEqual(['followed_private_author', 'public_author']);
    expect(mocks.getFollowingIdSet).toHaveBeenCalledTimes(1);
    expect(mocks.getFollowingIdSet).toHaveBeenCalledWith('viewer_1');
  });

  it('batches profile ACL follow checks across all protected candidates', async () => {
    mocks.entityFollowFind.mockImplementation(leanQuery([{ entityId: 'rust' }]));
    const protectedCandidates = Array.from({ length: 75 }, (_, i) => ({
      _id: `private_author_${i}`,
      matchedTags: [['rust']],
      postCount: i + 1,
    }));
    mocks.postAggregate.mockResolvedValue(protectedCandidates);
    mocks.userSettingsFind.mockImplementation(leanQuery(
      protectedCandidates.map((candidate) => ({
        oxyUserId: candidate._id,
        privacy: { profileVisibility: 'private' },
      })),
    ));
    mocks.getFollowingIdSet.mockResolvedValue(new Set(['private_author_7']));

    const service = makeService();
    const result = await service.getContentCandidates('viewer_1', { limit: 5 });

    expect(result.map((c) => c.userId)).toEqual(['private_author_7']);
    expect(mocks.getFollowingIdSet).toHaveBeenCalledTimes(1);
    expect(mocks.getFollowingIdSet).toHaveBeenCalledWith('viewer_1');
  });

  it('resolves engagement authors only from published public target posts', async () => {
    mocks.likeFind.mockImplementation(leanQuery([{ postId: 'p_public' }, { postId: 'p_private' }]));
    mocks.postFind.mockImplementation((match: Record<string, unknown>) => {
      if (match.type === 'boost') return leanQuery([])();
      if (match.parentPostId) return leanQuery([])();
      expect(match).toMatchObject({
        _id: { $in: ['p_public', 'p_private'] },
        status: 'published',
        visibility: 'public',
      });
      return leanQuery([{ _id: 'p_public', oxyUserId: 'public_author' }])();
    });

    const service = makeService();
    const result = await service.getContentCandidates('viewer_1');

    expect(result.map((c) => c.userId)).toEqual(['public_author']);
  });

  it('respects the candidate cap', async () => {
    mocks.entityFollowFind.mockImplementation(leanQuery([{ entityId: 'rust' }]));
    const many = Array.from({ length: 60 }, (_, i) => ({
      _id: `a${i}`,
      matchedTags: [['rust']],
      postCount: i + 1, // distinct weights so ordering is stable
    }));
    mocks.postAggregate.mockResolvedValue(many);

    const service = makeService();
    const result = await service.getContentCandidates('viewer_1', { limit: 5 });
    expect(result).toHaveLength(5);
  });

  it('degrades to [] when a signal query throws (soft-fail per signal)', async () => {
    mocks.entityFollowFind.mockImplementation(() => {
      throw new Error('db down');
    });
    // Engagement also empty.
    const service = makeService();
    const result = await service.getContentCandidates('viewer_1');
    expect(result).toEqual([]);
  });

  it('serves a cached result without re-querying', async () => {
    const cached = [{ userId: 'cached', weight: 5, reasons: ['engagement'] }];
    mocks.redisGet.mockResolvedValue(JSON.stringify(cached));
    mocks.getRedisClient.mockReturnValue({ isReady: true, get: mocks.redisGet, set: mocks.redisSet });

    const service = makeService();
    const result = await service.getContentCandidates('viewer_1');
    expect(result).toEqual(cached);
    expect(mocks.entityFollowFind).not.toHaveBeenCalled();
    expect(mocks.likeFind).not.toHaveBeenCalled();
  });
});

describe('ContentAffinityService UserBehavior signals', () => {
  it('uses preferredAuthors (maintained relationship weight) as the strongest signal', async () => {
    // A maxed-out preferred author (weight 1.0) must outrank a single hashtag-only
    // author covering one followed tag — preferred-author is the strongest signal.
    mocks.userBehaviorFindOne.mockImplementation(leanFindOne({
      preferredAuthors: [{ authorId: 'fav', weight: 1.0 }],
      preferredTopics: [],
      hiddenAuthors: [],
      mutedAuthors: [],
      blockedAuthors: [],
      hiddenTopics: [],
    }));
    mocks.entityFollowFind.mockImplementation(leanQuery([{ entityId: 'rust' }]));
    mocks.postAggregate.mockResolvedValue([
      { _id: 'tag_only', matchedTags: [['rust']], postCount: 1 },
    ]);

    const service = makeService();
    const result = await service.getContentCandidates('viewer_1');

    const fav = result.find((c) => c.userId === 'fav');
    const tagOnly = result.find((c) => c.userId === 'tag_only')?.weight ?? 0;
    expect(fav).toBeDefined();
    expect(fav?.reasons).toContain('preferred-author');
    expect(fav?.weight ?? 0).toBeGreaterThan(tagOnly);
  });

  it('scales the preferred-author contribution by the maintained weight', async () => {
    mocks.userBehaviorFindOne.mockImplementation(leanFindOne({
      preferredAuthors: [
        { authorId: 'strong', weight: 0.9 },
        { authorId: 'weak', weight: 0.1 },
      ],
      preferredTopics: [],
      hiddenAuthors: [],
      mutedAuthors: [],
      blockedAuthors: [],
      hiddenTopics: [],
    }));

    const service = makeService();
    const result = await service.getContentCandidates('viewer_1');

    const strong = result.find((c) => c.userId === 'strong')?.weight ?? 0;
    const weak = result.find((c) => c.userId === 'weak')?.weight ?? 0;
    expect(strong).toBeGreaterThan(weak);
    expect(weak).toBeGreaterThan(0);
  });

  it('topic affinity picks authors posting under the viewer\'s preferred topics', async () => {
    mocks.userBehaviorFindOne.mockImplementation(leanFindOne({
      preferredAuthors: [],
      preferredTopics: [
        { topic: 'machine_learning', weight: 0.8 },
        { topic: 'rust', weight: 0.3 },
      ],
      hiddenAuthors: [],
      mutedAuthors: [],
      blockedAuthors: [],
      hiddenTopics: [],
    }));
    // No followed hashtags → the hashtag aggregation returns []; the topic
    // aggregation (matched on postClassification.topics) returns the authors.
    mocks.postAggregate.mockImplementation((pipeline: Array<{ $match?: Record<string, unknown> }>) => {
      const match = pipeline[0]?.$match ?? {};
      if ('postClassification.topics' in match) {
        return Promise.resolve([
          { _id: 'ml_author', matchedTopics: [['machine_learning']], postCount: 3 },
          { _id: 'rust_author', matchedTopics: [['rust']], postCount: 1 },
        ]);
      }
      return Promise.resolve([]); // hashtag aggregation
    });

    const service = makeService();
    const result = await service.getContentCandidates('viewer_1');

    const ids = result.map((c) => c.userId);
    expect(ids).toContain('ml_author');
    expect(ids).toContain('rust_author');
    // The strongly-preferred topic (0.8) outweighs the weakly-preferred one (0.3).
    const ml = result.find((c) => c.userId === 'ml_author')?.weight ?? 0;
    const rust = result.find((c) => c.userId === 'rust_author')?.weight ?? 0;
    expect(ml).toBeGreaterThan(rust);
    expect(result.find((c) => c.userId === 'ml_author')?.reasons).toContain('topic');
  });

  it('strips hidden topics from the topic-affinity input', async () => {
    mocks.userBehaviorFindOne.mockImplementation(leanFindOne({
      preferredAuthors: [],
      preferredTopics: [
        { topic: 'crypto', weight: 0.9 }, // hidden → must not pull authors
        { topic: 'rust', weight: 0.5 },
      ],
      hiddenAuthors: [],
      mutedAuthors: [],
      blockedAuthors: [],
      hiddenTopics: ['crypto'],
    }));
    const seen: Array<Record<string, unknown>> = [];
    mocks.postAggregate.mockImplementation((pipeline: Array<{ $match?: Record<string, unknown> }>) => {
      const match = pipeline[0]?.$match ?? {};
      if ('postClassification.topics' in match) {
        seen.push(match);
      }
      return Promise.resolve([]);
    });

    const service = makeService();
    await service.getContentCandidates('viewer_1');

    // Exactly one topic aggregation ran, and it queried only the non-hidden topic.
    expect(seen).toHaveLength(1);
    const topicsIn = (seen[0]['postClassification.topics'] as { $in: string[] }).$in;
    expect(topicsIn).toEqual(['rust']);
  });

  it('excludes behavior-tracked hidden/muted/blocked authors from candidates', async () => {
    mocks.userBehaviorFindOne.mockImplementation(leanFindOne({
      // The negative author also appears as an engaged + preferred author — it must
      // STILL be excluded (suppression wins over affinity).
      preferredAuthors: [{ authorId: 'hidden_1', weight: 1.0 }],
      preferredTopics: [],
      hiddenAuthors: ['hidden_1'],
      mutedAuthors: ['muted_1'],
      blockedAuthors: ['blocked_1'],
      hiddenTopics: [],
    }));
    mocks.entityFollowFind.mockImplementation(leanQuery([{ entityId: 'rust' }]));
    mocks.postAggregate.mockResolvedValue([
      { _id: 'hidden_1', matchedTags: [['rust']], postCount: 1 },
      { _id: 'muted_1', matchedTags: [['rust']], postCount: 1 },
      { _id: 'blocked_1', matchedTags: [['rust']], postCount: 1 },
      { _id: 'good', matchedTags: [['rust']], postCount: 1 },
    ]);

    const service = makeService();
    const result = await service.getContentCandidates('viewer_1');

    const ids = result.map((c) => c.userId);
    expect(ids).toEqual(['good']);
  });

  it('degrades gracefully when the behavior load throws (no behavior signals)', async () => {
    mocks.userBehaviorFindOne.mockReturnValue({
      lean: vi.fn().mockRejectedValue(new Error('db down')),
    });
    // Hashtag affinity still produces a candidate — the behavior-derived signals
    // simply contribute nothing.
    mocks.entityFollowFind.mockImplementation(leanQuery([{ entityId: 'rust' }]));
    mocks.postAggregate.mockResolvedValue([
      { _id: 'tag_author', matchedTags: [['rust']], postCount: 1 },
    ]);

    const service = makeService();
    const result = await service.getContentCandidates('viewer_1');
    expect(result.map((c) => c.userId)).toContain('tag_author');
  });
});
