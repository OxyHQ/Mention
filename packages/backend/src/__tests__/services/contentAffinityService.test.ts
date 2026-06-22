import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  likeFind: vi.fn(),
  postFind: vi.fn(),
  postAggregate: vi.fn(),
  entityFollowFind: vi.fn(),
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
vi.mock('../../models/Block', () => ({ default: { find: mocks.blockFind } }));
vi.mock('../../models/Mute', () => ({ default: { find: mocks.muteFind } }));
vi.mock('../../models/Restrict', () => ({ default: { find: mocks.restrictFind } }));

vi.mock('../../utils/redis', () => ({
  getRedisClient: mocks.getRedisClient,
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
