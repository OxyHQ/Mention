import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CachedUserSummary } from '../../services/userSummaryCache';

/**
 * Determinism harness for the "boost disappears from a profile feed a few
 * seconds after load" bug.
 *
 * The profile feed hydrates a `type:'boost'` post at `maxDepth:1`. The boost
 * has an EMPTY content body and renders only via its embedded `boost.originalPost`
 * (resolved from `boostOf`). The symptom: the boost shows on first load, then
 * vanishes seconds later — exactly when the cold-boot auth identity change
 * (anon → authenticated) re-runs the profile feed fetch and `cachePosts`
 * overwrites the cached boost with whatever the SECOND fetch returns.
 *
 * This test exercises the REAL `hydratePosts` → `collectPostsWithDepth` →
 * `attachNestedContext` path against a boost whose original exists locally, and
 * asserts `boost.originalPost` embedding is DETERMINISTIC across repeated calls
 * AND identical for an anonymous viewer (fetch 1) vs. an authenticated viewer
 * (fetch 2). If the embedding ever differs, that non-determinism is the root
 * cause of the time-based disappearance.
 */

const BOOST_ID = '650000000000000000000001';
const ORIGINAL_ID = '650000000000000000000002';
const BOOSTER_OXY_ID = 'oxy-booster';
const ORIGINAL_AUTHOR_OXY_ID = 'oxy-original-author';
const VIEWER_ID = 'oxy-viewer';

const { getUserById, getUsersByIds, cacheStore, postFind, postFindOne, federatedActorFind } = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getUsersByIds: vi.fn(),
  cacheStore: new Map<string, CachedUserSummary>(),
  postFind: vi.fn(),
  postFindOne: vi.fn(),
  federatedActorFind: vi.fn(),
}));

vi.mock('../../../server', () => ({
  oxy: {
    getUserById,
    getUserFollowing: vi.fn(async () => []),
    getUserFollowers: vi.fn(async () => []),
  },
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ getUsersByIds }),
}));

// Privacy helpers: no blocks/restricts, empty follows. The authenticated path
// loads these; we return empty so the only difference from anon is "viewerId is
// set" — which is precisely what the cold-boot refetch changes.
vi.mock('../../utils/privacyHelpers', () => ({
  getBlockedUserIds: vi.fn(async () => []),
  getRestrictedUserIds: vi.fn(async () => []),
  extractFollowingIds: () => [],
  extractFollowersIds: () => [],
}));

// A chainable Mongoose query stub. `.select().sort().limit().maxTimeMS().lean()`
// all return `this`; `.lean()` resolves the provided rows (an array, or `null`
// for the `findOne` paths that return a single doc / no doc).
function chainable(rows: unknown[] | null) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'sort', 'limit', 'maxTimeMS']) {
    q[m] = () => q;
  }
  q.lean = async () => rows;
  q.then = undefined;
  return q;
}

vi.mock('../../models/Post', () => ({
  Post: {
    find: (...args: unknown[]) => chainable(postFind(...args)),
    findOne: (...args: unknown[]) => chainable(postFindOne(...args)),
  },
}));
vi.mock('../../models/Poll', () => ({ default: { find: () => chainable([]) } }));
vi.mock('../../models/Like', () => ({ default: { find: () => chainable([]) } }));
vi.mock('../../models/Bookmark', () => ({ default: { find: () => chainable([]) } }));
vi.mock('../../models/FederatedActor', () => ({
  default: { find: (...args: unknown[]) => chainable(federatedActorFind(...args)) },
}));
vi.mock('../../models/UserSettings', () => ({
  UserSettings: { find: () => chainable([]), findOne: () => chainable(null) },
}));

vi.mock('../../services/userSummaryCache', () => ({
  mget: vi.fn(async (ids: string[]) => {
    const hits = new Map<string, CachedUserSummary>();
    for (const id of ids) {
      const hit = cacheStore.get(id);
      if (hit) hits.set(id, hit);
    }
    return hits;
  }),
  mset: vi.fn(async (entries: Map<string, CachedUserSummary>) => {
    for (const [id, value] of entries) cacheStore.set(id, value);
  }),
}));

vi.mock('../../services/linkPreviewCache', () => ({
  readPreviews: vi.fn(async () => new Map()),
  storePreview: vi.fn(async () => undefined),
  markNoPreview: vi.fn(async () => undefined),
}));

import { PostHydrationService } from '../../services/PostHydrationService';

function makeOxyUser(id: string, username: string, displayName: string) {
  return {
    id,
    username,
    name: { displayName },
    badges: [],
    verified: false,
    isVerified: false,
  };
}

/** The boost row (depth 0): empty content, references the original via boostOf. */
function boostRow() {
  return {
    _id: BOOST_ID,
    oxyUserId: BOOSTER_OXY_ID,
    type: 'boost',
    boostOf: ORIGINAL_ID,
    content: { text: '' },
    stats: { likesCount: 0, boostsCount: 1, commentsCount: 0, downvotesCount: 0, viewsCount: 0 },
    metadata: { createdAt: new Date('2024-01-01T00:00:00Z') },
    createdAt: new Date('2024-01-01T00:00:00Z'),
    visibility: 'public',
    hashtags: [],
    mentions: [],
  };
}

/** The boosted original (depth 1): a normal note with real content. */
function originalRow() {
  return {
    _id: ORIGINAL_ID,
    oxyUserId: ORIGINAL_AUTHOR_OXY_ID,
    type: 'post',
    content: { text: 'the original note body' },
    stats: { likesCount: 5, boostsCount: 2, commentsCount: 1, downvotesCount: 0, viewsCount: 9 },
    metadata: { createdAt: new Date('2023-12-31T00:00:00Z') },
    createdAt: new Date('2023-12-31T00:00:00Z'),
    visibility: 'public',
    hashtags: [],
    mentions: [],
  };
}

describe('PostHydrationService — boost original embedding is deterministic', () => {
  let service: PostHydrationService;

  beforeEach(() => {
    cacheStore.clear();
    getUserById.mockReset();
    getUsersByIds.mockReset();
    postFind.mockReset();
    postFindOne.mockReset();
    federatedActorFind.mockReset();
    // No remote actor records resolve by default — orphaned federated posts fall
    // back to the deterministic domain placeholder. Individual tests override.
    federatedActorFind.mockReturnValue([]);

    // Both authors resolve via the bulk Oxy fetch.
    getUsersByIds.mockResolvedValue([
      makeOxyUser(BOOSTER_OXY_ID, 'booster', 'Booster'),
      makeOxyUser(ORIGINAL_AUTHOR_OXY_ID, 'author', 'Author'),
    ]);

    // The ONLY `Post.find` call that must return rows in this flow is the
    // depth-1 reference fetch (`_id: { $in: [ORIGINAL_ID] }`) inside
    // collectPostsWithDepth. The viewer-interaction boosts query
    // (`oxyUserId: viewerId, boostOf: { $in }`) and the recent-replier
    // aggregation must NOT match the original. Route by query shape.
    postFind.mockImplementation((query: Record<string, unknown> | undefined) => {
      const idIn = (query?._id as { $in?: unknown[] } | undefined)?.$in;
      if (Array.isArray(idIn) && idIn.map(String).includes(ORIGINAL_ID)) {
        return [originalRow()];
      }
      return [];
    });
  });

  async function hydrateBoost(viewerId?: string) {
    return service.hydratePosts([boostRow()], {
      viewerId,
      maxDepth: 1,
      includeLinkMetadata: false,
      includeFullMetadata: false,
    });
  }

  it('embeds the boosted original on EVERY repeated anonymous fetch', async () => {
    service = new PostHydrationService();
    for (let i = 0; i < 25; i++) {
      const [hydrated] = await hydrateBoost(undefined);
      expect(hydrated, `iteration ${i}: boost post missing`).toBeTruthy();
      expect(hydrated.boost, `iteration ${i}: boost context missing`).toBeTruthy();
      expect(hydrated.boost?.originalPost?.id, `iteration ${i}: original not embedded`).toBe(ORIGINAL_ID);
      expect(hydrated.originalPost?.id).toBe(ORIGINAL_ID);
    }
  });

  it('embeds the boosted original identically for anon (fetch 1) and authed (fetch 2)', async () => {
    service = new PostHydrationService();

    const [anon] = await hydrateBoost(undefined);
    const [authed] = await hydrateBoost(VIEWER_ID);

    expect(anon.boost?.originalPost?.id).toBe(ORIGINAL_ID);
    expect(authed.boost?.originalPost?.id).toBe(ORIGINAL_ID);
  });

  it('embeds the boosted original on EVERY repeated authenticated fetch', async () => {
    service = new PostHydrationService();
    for (let i = 0; i < 25; i++) {
      const [hydrated] = await hydrateBoost(VIEWER_ID);
      expect(hydrated.boost?.originalPost?.id, `iteration ${i}: original not embedded (authed)`).toBe(ORIGINAL_ID);
    }
  });

  // The core root-cause assertion: a boost's original is part of the boost's
  // renderable content and must embed REGARDLESS of the caller's maxDepth.
  // Every feed endpoint that hydrates boosts at maxDepth:0 (most of them) relied
  // on this; without the forced-boost-original collection the boost rendered
  // blank.
  it('embeds the boosted original even at maxDepth: 0 (the bug class)', async () => {
    service = new PostHydrationService();
    for (const depth of [0, 1, 2]) {
      const [hydrated] = await service.hydratePosts([boostRow()], {
        viewerId: undefined,
        maxDepth: depth,
        includeLinkMetadata: false,
        includeFullMetadata: false,
      });
      expect(hydrated.boost?.originalPost?.id, `maxDepth ${depth}: boost original missing`).toBe(ORIGINAL_ID);
      expect(hydrated.originalPost?.id, `maxDepth ${depth}: top-level originalPost missing`).toBe(ORIGINAL_ID);
    }
  });

  it('still embeds the original when the original has a NULL oxyUserId (orphaned federated actor)', async () => {
    service = new PostHydrationService();

    // The original exists locally, is public and federated, but its author actor
    // was never linked to an Oxy user (oxyUserId null) — the prod case where the
    // boost rendered blank even at maxDepth:1.
    postFind.mockImplementation((query: Record<string, unknown> | undefined) => {
      const idIn = (query?._id as { $in?: unknown[] } | undefined)?.$in;
      if (Array.isArray(idIn) && idIn.map(String).includes(ORIGINAL_ID)) {
        return [{
          ...originalRow(),
          oxyUserId: null,
          federation: { activityId: 'https://zpravobot.news/users/TerribleMaps/statuses/123' },
        }];
      }
      return [];
    });
    // Only the booster resolves; the original's author does not exist in Oxy.
    getUsersByIds.mockResolvedValue([makeOxyUser(BOOSTER_OXY_ID, 'booster', 'Booster')]);

    const [hydrated] = await hydrateBoost(undefined);

    expect(hydrated.boost?.originalPost?.id).toBe(ORIGINAL_ID);
    expect(hydrated.boost?.originalPost?.content?.text).toBe('the original note body');
    // The orphaned original gets a federation-domain placeholder author.
    expect(hydrated.boost?.originalPost?.user?.displayName).toBe('zpravobot.news');
    expect(hydrated.boost?.originalPost?.user?.isFederated).toBe(true);
  });

  it('carries the REMOTE actor displayName + avatarUrl when the FederatedActor resolves (orphaned)', async () => {
    service = new PostHydrationService();

    const activityId = 'https://zpravobot.news/users/TerribleMaps/statuses/123';
    postFind.mockImplementation((query: Record<string, unknown> | undefined) => {
      const idIn = (query?._id as { $in?: unknown[] } | undefined)?.$in;
      if (Array.isArray(idIn) && idIn.map(String).includes(ORIGINAL_ID)) {
        return [{
          ...originalRow(),
          oxyUserId: null,
          federation: { activityId },
        }];
      }
      return [];
    });
    getUsersByIds.mockResolvedValue([makeOxyUser(BOOSTER_OXY_ID, 'booster', 'Booster')]);

    // The remote actor IS known locally (orphaned: not linked to an Oxy user).
    // `uri` is a prefix of the post's federation.activityId — the canonical link.
    federatedActorFind.mockReturnValue([
      {
        uri: 'https://zpravobot.news/users/TerribleMaps',
        username: 'TerribleMaps',
        displayName: 'Terrible Maps',
        avatarUrl: 'https://zpravobot.news/system/accounts/avatars/terrible.png',
        domain: 'zpravobot.news',
        acct: 'TerribleMaps@zpravobot.news',
      },
    ]);

    const [hydrated] = await hydrateBoost(undefined);

    expect(hydrated.boost?.originalPost?.id).toBe(ORIGINAL_ID);
    // The REMOTE actor's real display name — NOT the bare domain.
    expect(hydrated.boost?.originalPost?.user?.displayName).toBe('Terrible Maps');
    expect(hydrated.boost?.originalPost?.user?.isFederated).toBe(true);
    expect(hydrated.boost?.originalPost?.user?.instance).toBe('zpravobot.news');
    // Remote avatar is carried through (resolved, not dropped).
    expect(hydrated.boost?.originalPost?.user?.avatarUrl).toBeTruthy();
  });

  it('does not embed non-public boost originals when publicReferencesOnly is enabled', async () => {
    service = new PostHydrationService();

    postFind.mockImplementation((query: Record<string, unknown> | undefined) => {
      const idIn = (query?._id as { $in?: unknown[] } | undefined)?.$in;
      if (!Array.isArray(idIn) || !idIn.map(String).includes(ORIGINAL_ID)) {
        return [];
      }

      expect(query).toMatchObject({
        status: 'published',
        visibility: 'public',
      });

      // Model the database predicate: a private/draft original does not match
      // the public-reference query and therefore must not be embedded into the
      // public actor-posts response.
      return [];
    });

    const [hydrated] = await service.hydratePosts([boostRow()], {
      viewerId: undefined,
      maxDepth: 1,
      publicReferencesOnly: true,
      includeLinkMetadata: false,
      includeFullMetadata: false,
    });

    expect(hydrated).toBeTruthy();
    expect(hydrated.boost).toBeNull();
    expect(hydrated.originalPost).toBeNull();
  });

});
