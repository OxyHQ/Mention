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
  getServiceOxyClient: () => ({
    getUsersByIds,
    getLinkPreviews: vi.fn(async () => ({})),
    getFileDownloadUrl: (id: string) => `https://cdn.test/${id}`,
  }),
}));

// Privacy helpers: no blocks/restricts, empty follows. The authenticated path
// loads these; we return empty so the only difference from anon is "viewerId is
// set" — which is precisely what the cold-boot refetch changes.
vi.mock('../../utils/privacyHelpers', () => ({
  getBlockedUserIds: vi.fn(async () => []),
  getRestrictedUserIds: vi.fn(async () => []),
  extractFollowingIds: vi.fn(() => []),
  extractFollowersIds: vi.fn(() => []),
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
vi.mock('../../models/UserSettings', () => ({
  UserSettings: { find: () => chainable([]), findOne: () => chainable(null) },
}));

// FederatedActor lookup, shared by two paths: the degraded-author enrichment
// (keyed by `oxyUserId`) and the orphan-federated-author resolution (keyed by
// `uri`). Routed by query via `federatedActorFind`; defaults to no rows so an
// unresolved federated author degrades to a neutral "Unknown user" (but its
// content STILL renders — orphans are no longer dropped).
vi.mock('../../models/FederatedActor', () => ({
  FederatedActor: { find: (...args: unknown[]) => ({ select: () => ({ lean: async () => federatedActorFind(...args) }) }) },
  default: { find: (...args: unknown[]) => ({ select: () => ({ lean: async () => federatedActorFind(...args) }) }) },
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
    authorship: [{ oxyUserId: BOOSTER_OXY_ID, role: 'owner', status: 'accepted' }],
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
    authorship: [{ oxyUserId: ORIGINAL_AUTHOR_OXY_ID, role: 'owner', status: 'accepted' }],
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
    // No FederatedActor rows unless a test opts in.
    federatedActorFind.mockResolvedValue([]);

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

  it('does not embed a non-public referenced original for an anonymous/global broadcast viewer', async () => {
    service = new PostHydrationService();

    postFind.mockImplementation((query: Record<string, unknown> | undefined) => {
      const idIn = (query?._id as { $in?: unknown[] } | undefined)?.$in;
      if (Array.isArray(idIn) && idIn.map(String).includes(ORIGINAL_ID)) {
        return [{
          ...originalRow(),
          visibility: 'private',
          status: 'draft',
          content: { text: 'private draft secret' },
        }];
      }
      return [];
    });

    const [hydrated] = await hydrateBoost(undefined);

    expect(hydrated, 'public boost should still hydrate').toBeTruthy();
    expect(hydrated.boost).toBeNull();
    expect(hydrated.originalPost).toBeNull();
  });

  it('allows a referenced followers-only original only for an authenticated follower viewer', async () => {
    service = new PostHydrationService();

    postFind.mockImplementation((query: Record<string, unknown> | undefined) => {
      const idIn = (query?._id as { $in?: unknown[] } | undefined)?.$in;
      if (Array.isArray(idIn) && idIn.map(String).includes(ORIGINAL_ID)) {
        return [{
          ...originalRow(),
          visibility: 'followers_only',
          status: 'published',
        }];
      }
      return [];
    });

    const { extractFollowingIds } = await import('../../utils/privacyHelpers');
    vi.mocked(extractFollowingIds).mockReturnValueOnce([ORIGINAL_AUTHOR_OXY_ID]);

    const [hydrated] = await hydrateBoost(VIEWER_ID);

    expect(hydrated.boost?.originalPost?.id).toBe(ORIGINAL_ID);
    expect(hydrated.originalPost?.id).toBe(ORIGINAL_ID);
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

  it('renders a federated boost original that has no oxyUserId in a degraded form (legacy orphan)', async () => {
    service = new PostHydrationService();

    // A LEGACY orphan: a federated original ingested before the federated-actor →
    // Oxy-user link was enforced, so its `oxyUserId` is null. It is NO LONGER
    // dropped — its content must render so the boost is not blank. With no
    // `actorUri` (a brid.gy/Bluesky-style note carrying only an `activityId`) and
    // no FederatedActor row, the author degrades to a neutral "Unknown user"
    // marked federated with the origin instance — never a fabricated handle.
    postFind.mockImplementation((query: Record<string, unknown> | undefined) => {
      const idIn = (query?._id as { $in?: unknown[] } | undefined)?.$in;
      if (Array.isArray(idIn) && idIn.map(String).includes(ORIGINAL_ID)) {
        return [{
          ...originalRow(),
          oxyUserId: null,
          authorship: [],
          federation: { activityId: 'https://zpravobot.news/users/TerribleMaps/statuses/123' },
        }];
      }
      return [];
    });
    // Only the booster resolves; the original's author does not exist in Oxy.
    getUsersByIds.mockResolvedValue([makeOxyUser(BOOSTER_OXY_ID, 'booster', 'Booster')]);

    const [hydrated] = await hydrateBoost(undefined);

    expect(hydrated).toBeTruthy();
    // The boost original now embeds, with its real content shown.
    expect(hydrated.boost?.originalPost?.id).toBe(ORIGINAL_ID);
    expect(hydrated.originalPost?.id).toBe(ORIGINAL_ID);
    expect(hydrated.boost?.originalPost?.content?.text).toBe('the original note body');
    // The author is the neutral, un-tappable "Unknown user" (ghost-handle rule:
    // empty handle), marked federated with the origin instance.
    const originalUser = hydrated.boost?.originalPost?.user;
    expect(originalUser?.username).toBe('');
    expect(originalUser?.name?.displayName).toBe('Unknown user');
    expect(originalUser?.isFederated).toBe(true);
    expect(originalUser?.instance).toBe('zpravobot.news');
    // No collaborator byline for an orphan — the header falls back to `user`.
    expect(hydrated.boost?.originalPost?.authors).toEqual([]);
  });

  it('renders an orphan federated boost original with its real handle from the FederatedActor record', async () => {
    service = new PostHydrationService();

    const ACTOR_URI = 'https://mastodon.online/users/kaleidotrope';
    postFind.mockImplementation((query: Record<string, unknown> | undefined) => {
      const idIn = (query?._id as { $in?: unknown[] } | undefined)?.$in;
      if (Array.isArray(idIn) && idIn.map(String).includes(ORIGINAL_ID)) {
        return [{
          ...originalRow(),
          oxyUserId: null,
          authorship: [],
          federation: { activityId: `${ACTOR_URI}/statuses/9`, actorUri: ACTOR_URI },
        }];
      }
      return [];
    });
    getUsersByIds.mockResolvedValue([makeOxyUser(BOOSTER_OXY_ID, 'booster', 'Booster')]);
    // The orphan-author resolution queries FederatedActor by `uri`.
    federatedActorFind.mockImplementation((query: Record<string, unknown> | undefined) => {
      const uriIn = (query?.uri as { $in?: unknown[] } | undefined)?.$in;
      if (Array.isArray(uriIn) && uriIn.map(String).includes(ACTOR_URI)) {
        return [{ uri: ACTOR_URI, username: 'kaleidotrope', acct: 'kaleidotrope@mastodon.online', domain: 'mastodon.online', avatarUrl: 'https://mastodon.online/a.png' }];
      }
      return [];
    });

    const [hydrated] = await hydrateBoost(undefined);

    const originalUser = hydrated.boost?.originalPost?.user;
    expect(hydrated.boost?.originalPost?.content?.text).toBe('the original note body');
    // Authoritative federated handle + avatar, never an invented display name.
    expect(originalUser?.username).toBe('kaleidotrope');
    expect(originalUser?.isFederated).toBe(true);
    expect(originalUser?.instance).toBe('mastodon.online');
    expect(originalUser?.federation?.domain).toBe('mastodon.online');
    expect(originalUser?.avatar).toBe('https://mastodon.online/a.png');
    expect(originalUser?.name?.displayName).toBeUndefined();
  });

  it('hydrates a bare orphan federated post viewed directly (not dropped from the depth-0 set)', async () => {
    service = new PostHydrationService();

    const orphanRow = {
      ...originalRow(),
      oxyUserId: null,
      authorship: [],
      federation: { activityId: 'https://bsky.brid.gy/convert/ap/at://did:plc:abc/app.bsky.feed.post/xyz' },
    };
    // Only the depth-1 reference fetch returns rows; the orphan is the depth-0
    // input, so no reference lookup is needed here.
    postFind.mockReturnValue([]);
    getUsersByIds.mockResolvedValue([]);

    const [hydrated] = await service.hydratePosts([orphanRow], {
      viewerId: undefined,
      maxDepth: 0,
      includeLinkMetadata: false,
      includeFullMetadata: false,
    });

    // The orphan is NOT filtered out of the initial depth-0 set — it renders.
    expect(hydrated).toBeTruthy();
    expect(hydrated.id).toBe(ORIGINAL_ID);
    expect(hydrated.content?.text).toBe('the original note body');
    expect(hydrated.user?.username).toBe('');
    expect(hydrated.user?.name?.displayName).toBe('Unknown user');
    expect(hydrated.user?.isFederated).toBe(true);
    expect(hydrated.user?.instance).toBe('bsky.brid.gy');
  });

  it('renders the Oxy name.displayName for a resolved federated boost original', async () => {
    service = new PostHydrationService();

    const FEDERATED_AUTHOR_OXY_ID = 'oxy-terrible-maps';
    postFind.mockImplementation((query: Record<string, unknown> | undefined) => {
      const idIn = (query?._id as { $in?: unknown[] } | undefined)?.$in;
      if (Array.isArray(idIn) && idIn.map(String).includes(ORIGINAL_ID)) {
        return [{
          ...originalRow(),
          oxyUserId: FEDERATED_AUTHOR_OXY_ID,
          authorship: [{ oxyUserId: FEDERATED_AUTHOR_OXY_ID, role: 'owner', status: 'accepted' }],
          federation: { activityId: 'https://zpravobot.news/users/TerribleMaps/statuses/123' },
        }];
      }
      return [];
    });

    // The federated author is now a real, resolved Oxy user. Oxy owns the clean
    // `name.displayName`, which is the SOLE name source — Mention never reads a
    // local FederatedActor name copy.
    getUsersByIds.mockResolvedValue([
      makeOxyUser(BOOSTER_OXY_ID, 'booster', 'Booster'),
      {
        id: FEDERATED_AUTHOR_OXY_ID,
        username: 'TerribleMaps@zpravobot.news',
        name: { displayName: 'Terrible Maps' },
        avatar: 'terrible-maps-avatar-file-id',
        isFederated: true,
        federation: { domain: 'zpravobot.news' },
        badges: [],
        verified: false,
        isVerified: false,
      },
    ]);

    const [hydrated] = await hydrateBoost(undefined);

    expect(hydrated.boost?.originalPost?.id).toBe(ORIGINAL_ID);
    // The Oxy `name.displayName` — the single source of truth.
    expect(hydrated.boost?.originalPost?.user?.name?.displayName).toBe('Terrible Maps');
    expect(hydrated.boost?.originalPost?.user?.isFederated).toBe(true);
    expect(hydrated.boost?.originalPost?.user?.instance).toBe('zpravobot.news');
    // The federated avatar (a bare Oxy file id) is carried through untouched.
    expect(hydrated.boost?.originalPost?.user?.avatar).toBe('terrible-maps-avatar-file-id');
  });

  it('still drops a NATIVE post with no author (a genuine data error, not a federated orphan)', async () => {
    service = new PostHydrationService();

    // A native (non-federated) post with a null author is a real data error — the
    // degraded-render path is scoped to FEDERATED orphans only, so this stays
    // dropped and never surfaces a nameless row.
    const nativeNullAuthor = {
      ...originalRow(),
      oxyUserId: null,
      authorship: [],
      // No `federation` subdoc → native.
    };
    postFind.mockReturnValue([]);
    getUsersByIds.mockResolvedValue([]);

    const hydrated = await service.hydratePosts([nativeNullAuthor], {
      viewerId: undefined,
      maxDepth: 0,
      includeLinkMetadata: false,
      includeFullMetadata: false,
    });

    expect(hydrated).toEqual([]);
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
