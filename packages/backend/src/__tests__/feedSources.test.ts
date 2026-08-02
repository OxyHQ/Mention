import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { PostType, PostVisibility } from '@mention/shared-types';
import { notAReplyClause } from '../utils/postReply';

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

/**
 * Lanes. `authoredSource` loads the profile owner's non-`mixed` lanes on every
 * gather, and `laneSource` loads the one lane it serves — both are stubbed here
 * so the tests drive the QUERY the sources build.
 *
 * `ownerLanes` is what `Lane.find` answers (the author's curated-away lanes);
 * `laneDoc` is what `Lane.findById` answers (the lane a lane tab addresses).
 */
let ownerLanes: Array<{ _id: unknown }> = [];
let laneDoc: { ownerType: string; ownerId: string; displayMode: string } | null = null;
vi.mock('../models/Lane', () => {
  const chain = <T>(value: T) => {
    const link = { select: () => link, sort: () => link, lean: () => Promise.resolve(value) };
    return link;
  };
  return {
    Lane: {
      find: vi.fn(() => chain(ownerLanes)),
      findById: vi.fn(() => chain(laneDoc)),
    },
  };
});

/** The likes tab reaches for `Like` instead of the author query. */
vi.mock('../models/Like', () => ({
  default: {
    find: vi.fn(() => ({
      sort: () => ({ limit: () => ({ select: () => ({ lean: async () => [] }) }) }),
    })),
  },
}));

import { Lane } from '../models/Lane';
import {
  followingSource,
  topicSource,
  globalDiscoverySource,
} from '../mtn/feed/engine/sources/forYouSources';
import { videosSource } from '../mtn/feed/engine/sources/discoverySources';
import {
  keywordsSource,
  authoredSource,
  laneSource,
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
  ownerLanes = [];
  laneDoc = null;
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
    expect(elemMatch.$or).toContainEqual({ durationSec: { $gte: 20 } });
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
  it('posts filter excludes replies under BOTH parent encodings', async () => {
    findRouter = () => [makePost(6)];
    await authoredSource.gather({ currentUserId: 'viewer' }, { authorId: 'a6', filter: 'posts' }, 31);
    const match = findCalls[0];
    expect(match).toMatchObject({
      authorship: { $elemMatch: { oxyUserId: 'a6', status: 'accepted' } },
    });
    // A `parentPostId`-only exclusion let a federated reply whose parent was
    // never linked locally through as if it were a thread root
    // (`utils/postReply`).
    expect(match.$and).toEqual([notAReplyClause()]);
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

  it('videos filter matches the two shapes videoOnly accepts — and NOT attachments', async () => {
    findRouter = () => [];
    await authoredSource.gather({ currentUserId: 'viewer' }, { authorId: 'a8b', filter: 'videos' }, 31);
    const and = findCalls[0].$and as Array<Record<string, unknown>>;
    const videoOr = and[0].$or as Array<Record<string, unknown>>;
    // Narrower than `media` on purpose: `videoOnlyFilter.keep` has no
    // `content.attachments` branch, so a query that fetched those posts would
    // only be paying for candidates the filter then drops.
    expect(videoOr.map((c) => Object.keys(c)[0])).toEqual(['type', 'content.media']);
    expect(videoOr[0]).toEqual({ type: PostType.VIDEO });
    expect(videoOr[1]).toEqual({ 'content.media': { $elemMatch: { type: 'video' } } });
    // Same top-level tab shape as `media`: roots only, no boosts.
    expect(and[1]).toEqual(notAReplyClause());
    expect(and[2]).toEqual({ $or: [{ boostOf: null }, { boostOf: { $exists: false } }] });
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

    // The filter switch only writes `query.$and`, so the sort lives outside it
    // and every tab inherits the same axis by construction. Pinned rather than
    // reasoned about, because a per-tab sort is exactly the change that would
    // reintroduce the skipped-page boundary on ONE tab and nowhere else.
    it('sorts on the same axis for every tab, not just posts', async () => {
      findRouter = () => [makePost(9)];
      for (const filter of ['replies', 'media', 'videos', 'boosts'] as const) {
        sortCalls.length = 0;
        await authoredSource.gather({ currentUserId: 'viewer' }, { authorId: 'a9', filter }, 31);
        expect(sortCalls[0]).toEqual({ createdAt: -1, _id: -1 });
      }
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
    expect(findCalls[0].$and).toEqual([notAReplyClause()]);
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

  /**
   * The author's own lane curation. `$nin` on a key of its OWN — never
   * `match.$or`, which `ChronoCursor.applyToQuery` assigns and would therefore
   * clobber on every page after the first.
   */
  describe('lane curation', () => {
    it('excludes the author\'s curated-away lanes with a flat $nin term', async () => {
      ownerLanes = [{ _id: oid(30) }, { _id: oid(31) }];
      findRouter = () => [makePost(32)];

      await authoredSource.gather({ currentUserId: 'viewer' }, { authorId: 'a32', filter: 'posts' }, 31);

      expect(findCalls[0].laneId).toEqual({
        $nin: [oid(30).toString(), oid(31).toString()],
      });
    });

    it('adds no lane clause at all when the author curated nothing', async () => {
      ownerLanes = [];
      findRouter = () => [makePost(33)];

      await authoredSource.gather({ currentUserId: 'viewer' }, { authorId: 'a33', filter: 'posts' }, 31);

      expect(findCalls[0].laneId).toBeUndefined();
    });

    it('keeps the exclusion OUT of $or, so a cursor cannot clobber it', async () => {
      ownerLanes = [{ _id: oid(34) }];
      findRouter = () => [makePost(35)];
      const anchor = { createdAt: new Date('2026-01-02T03:04:05.000Z'), _id: oid(35) };
      const cursor = ChronoCursor.build(String(anchor._id), anchor.createdAt);

      await authoredSource.gather(
        { currentUserId: 'viewer', cursor },
        { authorId: 'a35', filter: 'posts' },
        31,
      );

      const match = findCalls[0];
      // The cursor owns `$or` outright; the lane term survives beside it.
      expect(match.$or).toHaveLength(2);
      expect(match.laneId).toEqual({ $nin: [oid(34).toString()] });
    });

    it('coexists with the $and the media tab assigns', async () => {
      ownerLanes = [{ _id: oid(36) }];
      findRouter = () => [];

      await authoredSource.gather({ currentUserId: 'viewer' }, { authorId: 'a36', filter: 'media' }, 31);

      const match = findCalls[0];
      expect(Array.isArray(match.$and)).toBe(true);
      expect(match.laneId).toEqual({ $nin: [oid(36).toString()] });
    });

    it('never applies the author\'s curation to the likes tab', async () => {
      // The likes tab lists OTHER people's posts, so the profile owner's lanes
      // have no bearing on it — and it takes an entirely different code path.
      ownerLanes = [{ _id: oid(37) }];
      const posts = await authoredSource.gather(
        { currentUserId: 'viewer' },
        { authorId: 'a37', filter: 'likes' },
        31,
      );
      expect(posts).toEqual([]);
      expect(Lane.find).not.toHaveBeenCalled();
    });
  });
});

describe('lane source', () => {
  const LANE_ID = oid(40).toString();

  it('serves a `tab` lane, scoped to its publisher, on the chrono keyset', async () => {
    laneDoc = { ownerType: 'user', ownerId: 'owner-1', displayMode: 'tab' };
    findRouter = () => [makePost(41)];

    const posts = await laneSource.gather({ currentUserId: 'viewer' }, { laneId: LANE_ID }, 31);

    expect(posts.map((p) => String(p._id))).toEqual([oid(41).toString()]);
    const match = findCalls[0];
    // The LITERAL `laneId` term is what lets the PARTIAL index be used at all,
    // and `oxyUserId` is the publisher scope. `authorship` must NOT appear — its
    // multikey clause would pull the planner onto `post_author_chrono_v1`.
    expect(match.laneId).toBe(LANE_ID);
    expect(match.oxyUserId).toBe('owner-1');
    expect(match.authorship).toBeUndefined();
    expect(sortCalls[0]).toEqual({ createdAt: -1, _id: -1 });
  });

  it.each(['mixed', 'hidden'])('serves nothing for a `%s` lane', async (displayMode) => {
    laneDoc = { ownerType: 'user', ownerId: 'owner-1', displayMode };
    findRouter = () => [makePost(42)];

    const posts = await laneSource.gather({ currentUserId: 'viewer' }, { laneId: LANE_ID }, 31);

    // The gate that stops this descriptor being the way to read a lane its owner
    // took down: no query is even issued.
    expect(posts).toEqual([]);
    expect(findCalls).toHaveLength(0);
  });

  it('serves nothing when the reader cannot see the publisher', async () => {
    laneDoc = { ownerType: 'user', ownerId: 'owner-1', displayMode: 'tab' };
    profileVisibility = 'private';
    findRouter = () => [makePost(43)];

    const posts = await laneSource.gather(
      { currentUserId: 'viewer', followingIds: [] },
      { laneId: LANE_ID },
      31,
    );

    expect(posts).toEqual([]);
    expect(findCalls).toHaveLength(0);
  });

  it('serves a private publisher to a follower', async () => {
    laneDoc = { ownerType: 'user', ownerId: 'owner-1', displayMode: 'tab' };
    profileVisibility = 'private';
    findRouter = () => [makePost(44)];

    const posts = await laneSource.gather(
      { currentUserId: 'viewer', followingIds: ['owner-1'] },
      { laneId: LANE_ID },
      31,
    );

    expect(posts.map((p) => String(p._id))).toEqual([oid(44).toString()]);
  });

  it('serves nothing for a channel-owned lane, which has no visibility rule yet', async () => {
    laneDoc = { ownerType: 'channel', ownerId: 'channel-1', displayMode: 'tab' };
    findRouter = () => [makePost(45)];

    const posts = await laneSource.gather({ currentUserId: 'viewer' }, { laneId: LANE_ID }, 31);

    expect(posts).toEqual([]);
    expect(findCalls).toHaveLength(0);
  });

  it('serves nothing for a missing lane, a malformed id, or no id at all', async () => {
    laneDoc = null;
    expect(await laneSource.gather({}, { laneId: LANE_ID }, 31)).toEqual([]);
    expect(await laneSource.gather({}, { laneId: 'not-an-object-id' }, 31)).toEqual([]);
    expect(await laneSource.gather({}, {}, 31)).toEqual([]);
    expect(findCalls).toHaveLength(0);
  });

  it('pages on the compound createdAt keyset, never a bare _id boundary', async () => {
    laneDoc = { ownerType: 'user', ownerId: 'owner-1', displayMode: 'tab' };
    findRouter = () => [makePost(46)];
    const anchor = { createdAt: new Date('2026-02-03T04:05:06.000Z'), _id: oid(46) };
    const cursor = ChronoCursor.build(String(anchor._id), anchor.createdAt);

    await laneSource.gather({ currentUserId: 'viewer', cursor }, { laneId: LANE_ID }, 31);

    const match = findCalls[0];
    expect(match._id).toBeUndefined();
    expect(match.$or).toEqual([
      { createdAt: { $lt: anchor.createdAt } },
      { createdAt: anchor.createdAt, _id: { $lt: anchor._id } },
    ]);
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
