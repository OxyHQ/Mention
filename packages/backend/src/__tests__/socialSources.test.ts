import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { PostType, PostVisibility } from '@mention/shared-types';

/**
 * Unit tests for the social-graph SOURCE modules (mutuals upgrade + the new
 * follow/engagement-graph sources). The Post/Like/EntityFollow/StarterPack
 * models are mocked and every query match is captured so tests can assert the
 * exact clause each source builds.
 */

const findCalls: Array<Record<string, unknown>> = [];
let findRouter: (match: Record<string, unknown>) => unknown[] = () => [];
let likeAggregateResult: Array<Record<string, unknown>> = [];
let entityFollowDistinct: string[] = [];
let starterPackDoc: Record<string, unknown> | null = null;

function chainable(result: unknown[]) {
  const chain = {
    select: () => chain,
    sort: () => chain,
    limit: () => chain,
    maxTimeMS: () => chain,
    lean: () => Promise.resolve(result),
  };
  return chain;
}

vi.mock('../models/Post', () => ({
  Post: {
    find: vi.fn((match: Record<string, unknown>) => {
      findCalls.push(match);
      return chainable(findRouter(match));
    }),
    aggregate: vi.fn(() => ({ option: () => Promise.resolve([]) })),
  },
}));

vi.mock('../models/Like', () => ({
  default: {
    aggregate: vi.fn(() => ({ option: () => Promise.resolve(likeAggregateResult) })),
  },
}));

vi.mock('../models/EntityFollow', () => ({
  EntityFollow: {
    distinct: vi.fn(() => Promise.resolve(entityFollowDistinct)),
  },
}));

vi.mock('../models/StarterPack', () => ({
  StarterPack: {
    findById: vi.fn(() => ({ lean: () => Promise.resolve(starterPackDoc) })),
  },
}));

import { mutualsSource } from '../mtn/feed/engine/sources/userSources';
import {
  friendsEngagedSource,
  quotesSource,
  repliesFromFollowsSource,
  boostsFromFollowsSource,
  mentionsOfMeSource,
  hashtagFollowsSource,
  starterPackSource,
  onThisDaySource,
  friendsOfFriendsSource,
} from '../mtn/feed/engine/sources/socialSources';
import type { FeedEngineContext } from '../mtn/feed/engine/types';

const oid = (n: number) => new mongoose.Types.ObjectId(`5f${n.toString().padStart(22, '0')}`);
function makePost(n: number, extra: Record<string, unknown> = {}) {
  return { _id: oid(n), oxyUserId: `a${n}`, createdAt: new Date(), ...extra };
}

beforeEach(() => {
  findCalls.length = 0;
  findRouter = () => [];
  likeAggregateResult = [];
  entityFollowDistinct = [];
  starterPackDoc = null;
  vi.clearAllMocks();
});

describe('mutuals source', () => {
  it('queries ctx.mutualIds with public + followers-only visibility', async () => {
    findRouter = () => [makePost(1)];
    const ctx: FeedEngineContext = { currentUserId: 'viewer', mutualIds: ['m1', 'm2'] };
    const posts = await mutualsSource.gather(ctx, {}, 30);
    expect(posts.map((p) => String(p._id))).toEqual([oid(1).toString()]);
    const match = findCalls[0];
    expect(match.oxyUserId).toEqual({ $in: ['m1', 'm2'] });
    expect(match.visibility).toEqual({ $in: [PostVisibility.PUBLIC, PostVisibility.FOLLOWERS_ONLY] });
  });

  it('returns [] when ctx.mutualIds is empty', async () => {
    const posts = await mutualsSource.gather({ currentUserId: 'viewer' }, {}, 30);
    expect(posts).toEqual([]);
    expect(findCalls).toHaveLength(0);
  });
});

describe('friendsEngaged source', () => {
  it('orders posts by friend-engagement count and stamps finalScore', async () => {
    likeAggregateResult = [
      { _id: oid(10), friendCount: 1 },
      { _id: oid(11), friendCount: 3 },
    ];
    // Two posts fetched; the one liked by more friends must rank first.
    findRouter = (match) => {
      if (match.type === PostType.BOOST) return [];
      return [makePost(10), makePost(11)];
    };
    const ctx: FeedEngineContext = { currentUserId: 'viewer', followingIds: ['f1', 'f2'] };
    const posts = await friendsEngagedSource.gather(ctx, {}, 30);
    expect(posts.map((p) => String(p._id))).toEqual([oid(11).toString(), oid(10).toString()]);
    expect(posts[0].finalScore).toBe(3);
    // Main query excludes boosts + the viewer's own posts.
    const mainMatch = findCalls.find((m) => m._id) as Record<string, unknown>;
    expect(mainMatch.oxyUserId).toEqual({ $ne: 'viewer' });
    expect(mainMatch.visibility).toBe(PostVisibility.PUBLIC);
  });

  it('folds friend boosts into the engagement count', async () => {
    likeAggregateResult = [];
    findRouter = (match) => {
      if (match.type === PostType.BOOST) return [{ boostOf: oid(20).toString() }];
      return [makePost(20)];
    };
    const ctx: FeedEngineContext = { currentUserId: 'viewer', followingIds: ['f1'] };
    const posts = await friendsEngagedSource.gather(ctx, {}, 30);
    expect(posts.map((p) => String(p._id))).toEqual([oid(20).toString()]);
    expect(posts[0].finalScore).toBe(1);
  });

  it('returns [] with no follows', async () => {
    const posts = await friendsEngagedSource.gather({ currentUserId: 'viewer', followingIds: [] }, {}, 30);
    expect(posts).toEqual([]);
  });
});

describe('quotes source', () => {
  it('postId param → quotes of that post', async () => {
    findRouter = () => [makePost(2)];
    await quotesSource.gather({}, { postId: 'p123' }, 30);
    const match = findCalls[0];
    expect(match.quoteOf).toBe('p123');
  });

  it('authorIds param → quote posts by those authors', async () => {
    findRouter = () => [makePost(3)];
    await quotesSource.gather({}, { authorIds: ['a1'] }, 30);
    const match = findCalls[0];
    expect(match.quoteOf).toEqual({ $ne: null });
    expect(match.oxyUserId).toEqual({ $in: ['a1'] });
  });

  it('returns [] with no params', async () => {
    const posts = await quotesSource.gather({}, {}, 30);
    expect(posts).toEqual([]);
  });
});

describe('repliesFromFollows source', () => {
  it('queries replies authored by follows', async () => {
    findRouter = () => [makePost(4)];
    await repliesFromFollowsSource.gather({ currentUserId: 'viewer', followingIds: ['f1'] }, {}, 30);
    const match = findCalls[0];
    expect(match.oxyUserId).toEqual({ $in: ['f1'] });
    expect(match.parentPostId).toEqual({ $ne: null });
  });

  it('returns [] with no follows', async () => {
    const posts = await repliesFromFollowsSource.gather({ currentUserId: 'viewer', followingIds: [] }, {}, 30);
    expect(posts).toEqual([]);
  });
});

describe('boostsFromFollows source', () => {
  it('queries boost posts authored by follows', async () => {
    findRouter = () => [makePost(5, { type: PostType.BOOST })];
    await boostsFromFollowsSource.gather({ currentUserId: 'viewer', followingIds: ['f1'] }, {}, 30);
    const match = findCalls[0];
    expect(match.type).toBe(PostType.BOOST);
    expect(match.oxyUserId).toEqual({ $in: ['f1'] });
  });
});

describe('mentionsOfMe source', () => {
  it('matches posts whose mentions contain the viewer', async () => {
    findRouter = () => [makePost(6)];
    await mentionsOfMeSource.gather({ currentUserId: 'viewer' }, {}, 30);
    const match = findCalls[0];
    expect(match.mentions).toBe('viewer');
  });

  it('returns [] for an anonymous viewer', async () => {
    const posts = await mentionsOfMeSource.gather({}, {}, 30);
    expect(posts).toEqual([]);
  });
});

describe('hashtagFollows source', () => {
  it('resolves followed hashtags and matches them', async () => {
    entityFollowDistinct = ['Cats', 'Dogs'];
    findRouter = () => [makePost(7)];
    await hashtagFollowsSource.gather({ currentUserId: 'viewer' }, {}, 30);
    const match = findCalls[0];
    expect(match.hashtags).toEqual({ $in: ['cats', 'dogs'] });
  });

  it('returns [] when the viewer follows no hashtags', async () => {
    entityFollowDistinct = [];
    const posts = await hashtagFollowsSource.gather({ currentUserId: 'viewer' }, {}, 30);
    expect(posts).toEqual([]);
    expect(findCalls).toHaveLength(0);
  });
});

describe('starterPack source', () => {
  it('resolves pack members and matches their posts', async () => {
    starterPackDoc = { memberOxyUserIds: ['u1', 'u2'] };
    findRouter = () => [makePost(8)];
    await starterPackSource.gather({}, { packId: oid(99).toString() }, 30);
    const match = findCalls[0];
    expect(match.oxyUserId).toEqual({ $in: ['u1', 'u2'] });
  });

  it('returns [] for an invalid pack id', async () => {
    const posts = await starterPackSource.gather({}, { packId: 'not-an-id' }, 30);
    expect(posts).toEqual([]);
  });
});

describe('onThisDay source', () => {
  it('matches the viewer own posts from earlier years on today month/day', async () => {
    findRouter = () => [makePost(9)];
    await onThisDaySource.gather({ currentUserId: 'viewer' }, {}, 30);
    const match = findCalls[0];
    expect(match.oxyUserId).toBe('viewer');
    expect(match.$expr).toBeDefined();
  });

  it('follows scope widens to the viewer + follows', async () => {
    findRouter = () => [makePost(9)];
    await onThisDaySource.gather({ currentUserId: 'viewer', followingIds: ['f1'] }, { scope: 'follows' }, 30);
    const match = findCalls[0];
    expect(match.oxyUserId).toEqual({ $in: ['viewer', 'f1'] });
  });
});

describe('friendsOfFriends source', () => {
  it('queries ctx.fofIds with PUBLIC-only visibility', async () => {
    findRouter = () => [makePost(12)];
    const ctx: FeedEngineContext = { currentUserId: 'viewer', fofIds: ['x1', 'x2'] };
    const posts = await friendsOfFriendsSource.gather(ctx, {}, 30);
    expect(posts.map((p) => String(p._id))).toEqual([oid(12).toString()]);
    const match = findCalls[0];
    expect(match.oxyUserId).toEqual({ $in: ['x1', 'x2'] });
    expect(match.visibility).toBe(PostVisibility.PUBLIC);
  });

  it('returns [] when ctx.fofIds is empty', async () => {
    const posts = await friendsOfFriendsSource.gather({ currentUserId: 'viewer' }, {}, 30);
    expect(posts).toEqual([]);
    expect(findCalls).toHaveLength(0);
  });
});
