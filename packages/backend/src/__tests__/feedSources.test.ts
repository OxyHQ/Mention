import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { PostVisibility } from '@mention/shared-types';

/**
 * Unit tests for the engine SOURCE modules — each must reproduce the query of
 * the feed it wraps. The Post/Bookmark models are mocked and every query match
 * is captured so tests can assert the exact clause the wrapped source builds.
 */

const findCalls: Array<Record<string, unknown>> = [];
let findRouter: (match: Record<string, unknown>) => unknown[] = () => [];

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

const bookmarkDocs: Array<Record<string, unknown>> = [];
vi.mock('../models/Bookmark', () => ({
  default: {
    find: vi.fn(() => ({
      sort: () => ({ limit: () => ({ lean: () => Promise.resolve(bookmarkDocs) }) }),
    })),
  },
}));

import {
  followingSource,
  topicSource,
  globalDiscoverySource,
} from '../mtn/feed/engine/sources/forYouSources';
import { videosSource } from '../mtn/feed/engine/sources/discoverySources';
import {
  keywordsSource,
  authoredSource,
  savedSource,
  mutualsSource,
} from '../mtn/feed/engine/sources/userSources';
import type { FeedEngineContext } from '../mtn/feed/engine/types';

const oid = (n: number) => new mongoose.Types.ObjectId(`5f${n.toString().padStart(22, '0')}`);
function makePost(n: number, extra: Record<string, unknown> = {}) {
  return { _id: oid(n), oxyUserId: `a${n}`, createdAt: new Date(), ...extra };
}

beforeEach(() => {
  findCalls.length = 0;
  findRouter = () => [];
  bookmarkDocs.length = 0;
  vi.clearAllMocks();
});

describe('following source', () => {
  it('For You lane: queries followed authors (public only, no followers-only)', async () => {
    findRouter = () => [makePost(1)];
    const ctx: FeedEngineContext = { currentUserId: 'viewer', followingIds: ['f1'], seenPostIds: [] };
    const posts = await followingSource.gather(ctx, {}, 60);
    expect(posts.map((p) => String(p._id))).toEqual([oid(1).toString()]);
    const match = findCalls[0];
    expect(match.oxyUserId).toEqual({ $in: ['f1'] });
    expect(match.visibility).toBe(PostVisibility.PUBLIC);
  });

  it('timeline: uses the followers-only visibility match', async () => {
    findRouter = () => [makePost(2)];
    const ctx: FeedEngineContext = { currentUserId: 'viewer', followingIds: ['f1'], subscribedListMemberIds: [] };
    await followingSource.gather(ctx, { timeline: true }, 31);
    const match = findCalls[0];
    expect(match.visibility).toEqual({ $in: [PostVisibility.PUBLIC, PostVisibility.FOLLOWERS_ONLY] });
    expect(match.oxyUserId).toEqual({ $in: ['viewer', 'f1'] });
  });

  it('returns [] for an anonymous viewer (For You lane)', async () => {
    const posts = await followingSource.gather({ seenPostIds: [] }, {}, 60);
    expect(posts).toEqual([]);
  });
});

describe('topic source', () => {
  it('slug variant queries postClassification.topics with the lowercased slug', async () => {
    findRouter = () => [makePost(3)];
    await topicSource.gather({ currentUserId: 'viewer' }, { slug: 'Art' }, 31);
    const match = findCalls[0];
    expect(match['postClassification.topics']).toBe('art');
    expect(match.visibility).toBe('public');
  });
});

describe('globalDiscovery source', () => {
  it('applies the discovery sensitive exclusion (SFW viewer)', async () => {
    findRouter = () => [];
    await globalDiscoverySource.gather({ currentUserId: 'viewer', followingIds: [], seenPostIds: [] }, {}, 20);
    const match = findCalls[0];
    const and = match.$and as Array<Record<string, unknown>>;
    expect(and.some((c) => 'postClassification.sensitive' in c)).toBe(true);
  });
});

describe('videos source', () => {
  it('builds the video content match', async () => {
    findRouter = () => [makePost(4)];
    await videosSource.gather({ currentUserId: 'viewer', seenPostIds: [] }, {}, 90);
    const match = findCalls[0];
    const and = match.$and as Array<Record<string, unknown>>;
    const videoClause = and.find((c) => Array.isArray(c.$or) && (c.$or as Array<Record<string, unknown>>).some((o) => o.type === 'video'));
    expect(videoClause).toBeDefined();
  });
});

describe('keywords source', () => {
  it('single hashtag matches the hashtags array directly', async () => {
    findRouter = () => [makePost(5, { hashtags: ['cats'] })];
    const posts = await keywordsSource.gather({}, { hashtags: ['Cats'] }, 31);
    expect(posts.map((p) => String(p._id))).toEqual([oid(5).toString()]);
    const match = findCalls[0];
    expect(match.hashtags).toBe('cats');
  });

  it('returns [] with no hashtags or keywords', async () => {
    const posts = await keywordsSource.gather({}, {}, 31);
    expect(posts).toEqual([]);
  });
});

describe('authored source', () => {
  it('posts filter queries the author with parentPostId null', async () => {
    findRouter = () => [makePost(6)];
    await authoredSource.gather({ currentUserId: 'viewer' }, { authorId: 'a6', filter: 'posts' }, 31);
    const match = findCalls[0];
    expect(match.oxyUserId).toBe('a6');
    expect(match.parentPostId).toBeNull();
  });
});

describe('saved source', () => {
  it('returns bookmarked posts in bookmark order with a next cursor when there are more', async () => {
    bookmarkDocs.push(
      { _id: oid(20), postId: oid(10), createdAt: new Date() },
      { _id: oid(21), postId: oid(11), createdAt: new Date() },
    );
    // pageLimit 1 → hasMore (2 bookmarks), process 1, one post found.
    findRouter = () => [makePost(10)];
    const posts = await savedSource.gather({ currentUserId: 'viewer', pageLimit: 1 }, {}, 2);
    expect(posts.map((p) => String(p._id))).toEqual([oid(10).toString()]);
    expect(posts[posts.length - 1]._feedCursor).toBeTruthy();
  });

  it('returns [] for an anonymous viewer', async () => {
    const posts = await savedSource.gather({ pageLimit: 30 }, {}, 31);
    expect(posts).toEqual([]);
  });
});

describe('mutuals source (Phase 1 placeholder)', () => {
  it('returns []', async () => {
    const posts = await mutualsSource.gather({ currentUserId: 'viewer' }, {}, 30);
    expect(posts).toEqual([]);
  });
});
