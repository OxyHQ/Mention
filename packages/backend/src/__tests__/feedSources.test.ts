import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { PostVisibility } from '@mention/shared-types';

/**
 * Unit tests for the engine SOURCE modules — each must reproduce the query of
 * the feed it wraps. The Post/Bookmark models are mocked and every query match
 * is captured so tests can assert the exact clause the wrapped source builds.
 */

const findCalls: Array<Record<string, unknown>> = [];
const sortCalls: Array<Record<string, unknown>> = [];
let findRouter: (match: Record<string, unknown>) => unknown[] = () => [];

function chainable(result: unknown[]) {
  const chain = {
    select: () => chain,
    sort: (spec: Record<string, unknown>) => {
      sortCalls.push(spec);
      return chain;
    },
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

/**
 * Profile visibility drives the author feed's access gate. Default: a public
 * profile (no settings row); individual tests override to exercise the gate.
 */
let profileVisibility: string | undefined;
vi.mock('../models/UserSettings', () => ({
  default: {
    findOne: vi.fn(() => ({
      lean: () => Promise.resolve(
        profileVisibility ? { privacy: { profileVisibility } } : null,
      ),
    })),
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
import { ChronoCursor } from '../mtn/feed/CursorBuilder';
import type { FeedEngineContext } from '../mtn/feed/engine/types';

const oid = (n: number) => new mongoose.Types.ObjectId(`5f${n.toString().padStart(22, '0')}`);
function makePost(n: number, extra: Record<string, unknown> = {}) {
  return { _id: oid(n), oxyUserId: `a${n}`, createdAt: new Date(), ...extra };
}

/**
 * Evaluate the topic `$or` a source built against a fixture post — proving the
 * query MATCHES the right documents, not merely that its shape looks right.
 * Mirrors how Mongo applies the two-branch clause: a post is on the topic when
 * EITHER a `postClassification.topicRefs[].name` OR a `postClassification.topics`
 * slug equals the queried slug. The clause is nested under `$and`.
 */
function matchesTopicOr(match: Record<string, unknown>, post: Record<string, unknown>): boolean {
  const and = (match.$and as Array<Record<string, unknown>> | undefined) ?? [];
  const orClause = and
    .map((clause) => clause.$or)
    .find((value): value is Array<Record<string, string>> => Array.isArray(value));
  if (!orClause) return false;
  const classification = post.postClassification as
    | { topics?: string[]; topicRefs?: Array<{ name: string }> }
    | undefined;
  return orClause.some((branch) => {
    const refName = branch['postClassification.topicRefs.name'];
    if (refName !== undefined) {
      return (classification?.topicRefs ?? []).some((ref) => ref.name === refName);
    }
    const slug = branch['postClassification.topics'];
    if (slug !== undefined) {
      return (classification?.topics ?? []).includes(slug);
    }
    return false;
  });
}

beforeEach(() => {
  findCalls.length = 0;
  sortCalls.length = 0;
  findRouter = () => [];
  bookmarkDocs.length = 0;
  profileVisibility = undefined;
  vi.clearAllMocks();
});

describe('following source', () => {
  it('For You lane: queries followed authors (public only, no followers-only)', async () => {
    findRouter = () => [makePost(1)];
    const ctx: FeedEngineContext = { currentUserId: 'viewer', followingIds: ['f1'], seenPostIds: [] };
    const posts = await followingSource.gather(ctx, {}, 60);
    expect(posts.map((p) => String(p._id))).toEqual([oid(1).toString()]);
    const match = findCalls[0];
    expect(match).toMatchObject({
      authorship: { $elemMatch: { oxyUserId: { $in: ['f1'] }, status: 'accepted' } },
      visibility: PostVisibility.PUBLIC,
    });
  });

  it('timeline: uses the followers-only visibility match', async () => {
    findRouter = () => [makePost(2)];
    const ctx: FeedEngineContext = { currentUserId: 'viewer', followingIds: ['f1'], subscribedListMemberIds: [] };
    await followingSource.gather(ctx, { timeline: true }, 31);
    const match = findCalls[0];
    expect(match).toMatchObject({
      authorship: { $elemMatch: { oxyUserId: { $in: ['viewer', 'f1'] }, status: 'accepted' } },
      visibility: { $in: [PostVisibility.PUBLIC, PostVisibility.FOLLOWERS_ONLY] },
    });
  });

  it('returns [] for an anonymous viewer (For You lane)', async () => {
    const posts = await followingSource.gather({ seenPostIds: [] }, {}, 60);
    expect(posts).toEqual([]);
  });
});

describe('topic source', () => {
  it('slug variant matches topicRefs.name OR the slug-only topics (lowercased, public/published)', async () => {
    findRouter = () => [makePost(3)];
    await topicSource.gather({ currentUserId: 'viewer' }, { slug: 'Art' }, 31);
    const match = findCalls[0];
    // The topic OR is nested under `$and` so a cursor `$or` cannot clobber it.
    const and = match.$and as Array<Record<string, unknown>>;
    expect(and[0].$or).toEqual([
      { 'postClassification.topicRefs.name': 'art' },
      { 'postClassification.topics': 'art' },
    ]);
    expect(match.visibility).toBe('public');
    expect(match.status).toBe('published');
  });

  /**
   * Regression: "a topic trends but its page shows no posts".
   *
   * TrendingService counts a topic from `postClassification.topicRefs` (Stage-B
   * canonical) OR `postClassification.topics` (Stage-A slug). The topic feed used
   * to match ONLY `postClassification.topics`, so a post classified with a
   * canonical `topicRefs` "tech" but no "tech" slug in `topics` was counted as
   * trending yet never returned by the feed. The feed must now return it too.
   */
  it('returns a post associated via topicRefs.name only, and excludes an unrelated post', async () => {
    const techViaRefsOnly = makePost(3, {
      postClassification: { topics: ['news'], topicRefs: [{ name: 'tech' }] },
    });
    const unrelated = makePost(4, {
      postClassification: { topics: ['sports'], topicRefs: [{ name: 'sports' }] },
    });
    findRouter = (match) => [techViaRefsOnly, unrelated].filter((post) => matchesTopicOr(match, post));

    const posts = await topicSource.gather({ currentUserId: 'viewer' }, { slug: 'tech' }, 31);
    expect(posts.map((p) => String(p._id))).toEqual([oid(3).toString()]);
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
  it('builds the video content match with metadata elemMatch', async () => {
    findRouter = () => [makePost(4)];
    await videosSource.gather({ currentUserId: 'viewer', seenPostIds: [] }, {}, 90);
    const match = findCalls[0];
    const and = match.$and as Array<Record<string, unknown>>;
    const mediaClause = and.find((c) => typeof c['content.media'] === 'object');
    expect(mediaClause).toBeDefined();
    const elemMatch = (mediaClause?.['content.media'] as { $elemMatch: Record<string, unknown> }).$elemMatch;
    expect(elemMatch.type).toBe('video');
    expect(elemMatch.durationSec).toEqual({ $gte: 20 });
    expect(elemMatch.orientation).toBe('portrait');
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
    expect(match).toMatchObject({
      authorship: { $elemMatch: { oxyUserId: 'a6', status: 'accepted' } },
      parentPostId: null,
    });
  });

  it('boosts filter queries the author\'s boosts', async () => {
    findRouter = () => [makePost(7, { boostOf: oid(1) })];
    await authoredSource.gather({ currentUserId: 'viewer' }, { authorId: 'a7', filter: 'boosts' }, 31);
    const match = findCalls[0];
    expect(match).toMatchObject({
      authorship: { $elemMatch: { oxyUserId: 'a7', status: 'accepted' } },
      boostOf: { $ne: null },
    });
  });

  it('media filter matches every media shape the mediaOnly predicate accepts', async () => {
    findRouter = () => [];
    await authoredSource.gather({ currentUserId: 'viewer' }, { authorId: 'a8', filter: 'media' }, 31);
    const and = findCalls[0].$and as Array<Record<string, unknown>>;
    const mediaOr = (and[0].$or as Array<Record<string, unknown>>).map((c) => Object.keys(c)[0]);
    expect(mediaOr).toEqual(['type', 'content.media.0', 'content.attachments']);
  });

  /**
   * Regression: "a boost disappears from the profile feed".
   *
   * A federated boost/note is imported with `createdAt = <remote published>`
   * while its `_id` is generated at IMPORT time, so an OLD post can carry a
   * LARGE `_id`. Paginate a `createdAt`-ordered feed with an `_id` boundary (or
   * order an `_id`-sorted fetch behind a `createdAt` boundary) and those posts
   * fall on the wrong side of the page edge and are skipped forever. The sort
   * axis and the cursor axis MUST be the same one.
   */
  describe('cursor/sort axis (federated posts must not fall off the page edge)', () => {
    it('sorts by createdAt, not _id', async () => {
      findRouter = () => [makePost(9)];
      await authoredSource.gather({ currentUserId: 'viewer' }, { authorId: 'a9', filter: 'posts' }, 31);
      expect(sortCalls[0]).toEqual({ createdAt: -1, _id: -1 });
    });

    it('pages with a compound createdAt keyset, not a bare _id boundary', async () => {
      findRouter = () => [];
      const anchor = makePost(9);
      const cursor = ChronoCursor.build(String(anchor._id), anchor.createdAt);

      await authoredSource.gather(
        { currentUserId: 'viewer', cursor },
        { authorId: 'a9', filter: 'posts' },
        31,
      );

      const match = findCalls[0];
      expect(match._id).toBeUndefined();
      expect(match.$or).toEqual([
        { createdAt: { $lt: anchor.createdAt } },
        { createdAt: anchor.createdAt, _id: { $lt: anchor._id } },
      ]);
    });
  });

  it('an unknown filter degrades to posts rather than erroring', async () => {
    findRouter = () => [makePost(10)];
    await authoredSource.gather({ currentUserId: 'viewer' }, { authorId: 'a10', filter: 'bogus' }, 31);
    expect(findCalls[0]).toMatchObject({ parentPostId: null });
  });

  describe('profile visibility gate', () => {
    it('returns [] without querying when a non-follower views a private profile', async () => {
      profileVisibility = 'private';
      findRouter = () => [makePost(11)];
      const posts = await authoredSource.gather(
        { currentUserId: 'viewer', followingIds: ['someone-else'] },
        { authorId: 'a11', filter: 'posts' },
        31,
      );
      expect(posts).toEqual([]);
      expect(findCalls).toHaveLength(0);
    });

    it('returns [] for an anonymous viewer on a followers-only profile', async () => {
      profileVisibility = 'followers_only';
      findRouter = () => [makePost(12)];
      const posts = await authoredSource.gather({}, { authorId: 'a12', filter: 'posts' }, 31);
      expect(posts).toEqual([]);
      expect(findCalls).toHaveLength(0);
    });

    it('serves a private profile to a follower', async () => {
      profileVisibility = 'private';
      findRouter = () => [makePost(13)];
      const posts = await authoredSource.gather(
        { currentUserId: 'viewer', followingIds: ['a13'] },
        { authorId: 'a13', filter: 'posts' },
        31,
      );
      expect(posts.map((p) => String(p._id))).toEqual([oid(13).toString()]);
    });

    it('serves a private profile to its owner', async () => {
      profileVisibility = 'private';
      findRouter = () => [makePost(14)];
      const posts = await authoredSource.gather(
        { currentUserId: 'a14' },
        { authorId: 'a14', filter: 'posts' },
        31,
      );
      expect(posts.map((p) => String(p._id))).toEqual([oid(14).toString()]);
    });

    it('gates the media tab too, not just likes', async () => {
      profileVisibility = 'private';
      findRouter = () => [makePost(15)];
      const posts = await authoredSource.gather(
        { currentUserId: 'viewer', followingIds: [] },
        { authorId: 'a15', filter: 'media' },
        31,
      );
      expect(posts).toEqual([]);
      expect(findCalls).toHaveLength(0);
    });
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
