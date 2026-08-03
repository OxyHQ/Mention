/**
 * `ContentAffinityService` end to end, against real Postgres rows.
 *
 * Four of this service's five inputs crossed the store boundary in this batch —
 * `likes`, `posts` (reply/boost targets, author resolution, and the two coverage
 * aggregations), `entity_follows` and `user_settings` all live in Postgres now.
 * The suite this replaces mocked the four Mongoose models, so after the port the
 * mocks intercepted nothing and every data-dependent case quietly asserted
 * against an empty result. That is the exact shape this file exists to stop:
 * signals are asserted on ROWS the service actually read, and on the WEIGHTS it
 * derived from them, never on the arguments of a query.
 *
 * Still mocked, deliberately:
 *
 *  - `mtn/UserPrivacyManager` and `utils/privacyHelpers.getFollowingIdSet` — the
 *    Oxy-owned block/mute/restrict relations and follow graph.
 *  - `utils/redis` — the per-viewer result cache, off by default so every case
 *    below measures a real computation.
 *  - `PostHydrationService` / `FeedRankingService` — the authority blend is
 *    stubbed NEUTRAL (multiplier exactly 1.0) so the weights asserted here are
 *    the pure content-affinity values and not a follower-count lookup.
 *
 * Two harness rules, both load-bearing:
 *
 *  - The test database is SHARED with the rest of the suite and the coverage
 *    aggregations scan it globally, so every fixture id, hashtag and topic
 *    carries the {@link NS} prefix and every assertion is scoped through
 *    {@link ours}. A bare `expect(result)` here would pass or fail on what a
 *    sibling file happened to insert.
 *  - Weights are asserted as VALUES, not as orderings alone. An ordering holds
 *    under a formula that has silently lost its volume bonus or its per-topic
 *    scaling; the value does not.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { MtnConfig, PostType, PostVisibility } from '@mention/shared-types';

const mocks = vi.hoisted(() => ({
  /**
   * Fault injected into the behaviour READ for the soft-fail case only. Every
   * other case goes through the real repository against real rows — a mocked
   * read would make the aggregate a value this file supplies rather than one the
   * service loaded.
   */
  behaviorLoadError: null as Error | null,
  loadPrivacyState: vi.fn(),
  getFollowingIdSet: vi.fn(),
  getRedisClient: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
}));

vi.mock('../../db/userProfile/userBehaviorRepository', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../db/userProfile/userBehaviorRepository')
  >();
  return {
    ...actual,
    loadUserBehavior: async (oxyUserId: string) => {
      if (mocks.behaviorLoadError) throw mocks.behaviorLoadError;
      return actual.loadUserBehavior(oxyUserId);
    },
  };
});
vi.mock('../../mtn/UserPrivacyManager', () => ({
  UserPrivacyManager: { loadPrivacyState: mocks.loadPrivacyState },
}));
vi.mock('../../utils/redis', () => ({
  getRedisClient: mocks.getRedisClient,
}));
vi.mock('../../utils/privacyHelpers', () => ({
  ProfileVisibility: { PUBLIC: 'public', PRIVATE: 'private', FOLLOWERS_ONLY: 'followers_only' },
  requiresAccessCheck: (visibility: string | undefined) =>
    visibility === 'private' || visibility === 'followers_only',
  getFollowingIdSet: mocks.getFollowingIdSet,
}));

// The authority blend dynamically imports these; stub them so the blend is a
// deterministic NEUTRAL no-op (every candidate gets multiplier 1.0). This is
// what lets the weight assertions below be exact.
vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock('../../services/FeedRankingService', () => ({
  feedRankingService: { calculateAuthorityScore: vi.fn().mockReturnValue(1.0) },
}));

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { entityFollows, likes } from '../../db/schema/engagement';
import { userSettings } from '../../db/schema/userProfile';
import { insertPostRecord } from '../../db/posts/postRepository';
import {
  deleteUserBehavior,
  updateUserBehavior,
} from '../../db/userProfile/userBehaviorRepository';
import type { PostRecordInput } from '../../db/posts/postRecord';
import type { OxyClient } from '../../utils/privacyHelpers';
import { ContentAffinityService, type ContentCandidate } from '../../services/ContentAffinityService';

/**
 * Namespace for every id, hashtag and topic this file writes. The coverage
 * aggregations match on tag/topic VALUES across the whole table, so a bare
 * `tech` here would be scored against whatever a sibling suite inserted.
 */
const NS = 'affsvc';

/** An id inside this suite's namespace. */
const id = (name: string): string => `${NS}-${name}`;

const VIEWER = id('viewer');

/**
 * The video-surface author dampener, read from the shared config rather than
 * restated: it is the same constant `UserBehavior` attribution uses, and a test
 * carrying its own copy would keep passing after the product decision changed.
 */
const VIDEO_FACTOR = MtnConfig.preferences.engagementContext.videoSurfaceAuthorAffinityFactor;

/**
 * The saturating post-volume bonus both coverage signals add, expressed as the
 * VALUES it takes for the post counts these fixtures produce. Deliberately
 * literals and not a re-implementation of `log1p(n)/log1p(n+4)` — a test that
 * recomputes the formula agrees with any formula.
 */
const VOLUME_BONUS_1_POST = 0.3868528072345416;
const VOLUME_BONUS_2_POSTS = 0.5645750340535796;
const VOLUME_BONUS_3_POSTS = 0.6666666666666667;

let db: Database;
const service = new ContentAffinityService();

const createdPostIds: string[] = [];
const createdSettingsOwners: string[] = [];

/** Shape of the maintained behavior aggregate the service actually reads. */
interface BehaviorFixture {
  preferredAuthors: Array<{ authorId: string; weight: number }>;
  preferredTopics: Array<{ topic: string; weight: number }>;
  hiddenAuthors: string[];
  mutedAuthors: string[];
  blockedAuthors: string[];
  hiddenTopics: string[];
}

/**
 * Write the viewer's behaviour aggregate as REAL rows (null = cold viewer).
 *
 * `preferredAuthors` and `preferredTopics` are child tables, so the weights
 * asserted below only survive if the repository writes and reads them back — a
 * stub returning the fixture verbatim could not tell those apart.
 */
async function seedBehavior(doc: BehaviorFixture | null): Promise<void> {
  await deleteUserBehavior(VIEWER);
  if (!doc) return;
  await updateUserBehavior(
    VIEWER,
    (record) => {
      record.preferredAuthors = doc.preferredAuthors.map((author) => ({
        authorId: author.authorId,
        interactionCount: 0,
        lastInteractionAt: new Date(),
        interactionTypes: { likes: 0, boosts: 0, comments: 0, saves: 0, shares: 0 },
        weight: author.weight,
      }));
      record.preferredTopics = doc.preferredTopics.map((topic) => ({
        topic: topic.topic,
        interactionCount: 0,
        lastInteractionAt: new Date(),
        weight: topic.weight,
      }));
      record.hiddenAuthors = doc.hiddenAuthors;
      record.mutedAuthors = doc.mutedAuthors;
      record.blockedAuthors = doc.blockedAuthors;
      record.hiddenTopics = doc.hiddenTopics;
    },
    { createIfMissing: true },
  );
}

/** A behavior document with only the lists a case cares about populated. */
function behavior(overrides: Partial<BehaviorFixture> = {}): BehaviorFixture {
  return {
    preferredAuthors: [],
    preferredTopics: [],
    hiddenAuthors: [],
    mutedAuthors: [],
    blockedAuthors: [],
    hiddenTopics: [],
    ...overrides,
  };
}

async function createPost(oxyUserId: string, overrides: Partial<PostRecordInput> = {}) {
  const record = await insertPostRecord({
    oxyUserId,
    authorship: [{ oxyUserId, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'affinity fixture', tag: 'en' }] },
    ...overrides,
  });
  createdPostIds.push(record.id);
  return record;
}

/** An up-vote by the viewer, optionally stamped with the surface it came from. */
async function likePost(postId: string, source?: string): Promise<void> {
  await db.insert(likes).values({ userId: VIEWER, postId, value: 1, source: source ?? null });
}

async function followHashtag(tag: string): Promise<void> {
  await db.insert(entityFollows).values({ userId: VIEWER, entityType: 'hashtag', entityId: tag });
}

async function setProfileVisibility(
  owners: string[],
  visibility: 'private' | 'followers_only',
): Promise<void> {
  if (owners.length === 0) return;
  await db
    .insert(userSettings)
    .values(owners.map((oxyUserId) => ({ oxyUserId, privacyProfileVisibility: visibility })));
  createdSettingsOwners.push(...owners);
}

/**
 * Candidates this suite created. Every query in the service scans the whole
 * (shared) database, so an unscoped assertion would depend on sibling suites.
 */
function ours(candidates: ContentCandidate[]): ContentCandidate[] {
  return candidates.filter((candidate) => candidate.userId.startsWith(`${NS}-`));
}

function ourIds(candidates: ContentCandidate[]): string[] {
  return ours(candidates).map((candidate) => candidate.userId);
}

function weightOf(candidates: ContentCandidate[], userId: string): number | undefined {
  return candidates.find((candidate) => candidate.userId === userId)?.weight;
}

/** A viewer-scoped Oxy client — the object the service must forward, unaltered. */
const scopedOxyClient: OxyClient = {
  getBlockedUsers: async () => [],
  getRestrictedUsers: async () => [],
  getUserFollowing: async () => ({}),
  getUserFollowers: async () => ({}),
  getViewerGraph: async () => ({}),
};

beforeAll(async () => {
  db = await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.behaviorLoadError = null;
  // Redis disabled by default → every case measures a real computation.
  mocks.getRedisClient.mockReturnValue({ isReady: false, get: mocks.redisGet, set: mocks.redisSet });
  mocks.loadPrivacyState.mockResolvedValue({
    blockedUserIds: new Set(),
    mutedUserIds: new Set(),
    restrictedUserIds: new Set(),
    excludedUserIds: new Set(),
  });
  mocks.getFollowingIdSet.mockResolvedValue(new Set());
  await seedBehavior(null);
});

afterEach(async () => {
  await deleteUserBehavior(VIEWER);
  await db.delete(likes).where(eq(likes.userId, VIEWER));
  if (createdPostIds.length > 0) {
    await db.delete(posts).where(inArray(posts.id, createdPostIds.splice(0)));
  }
  await db.delete(entityFollows).where(eq(entityFollows.userId, VIEWER));
  if (createdSettingsOwners.length > 0) {
    await db.delete(userSettings).where(inArray(userSettings.oxyUserId, createdSettingsOwners.splice(0)));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('a viewer with nothing to go on', () => {
  it('returns [] when the viewer has no followed hashtags and no engagement', async () => {
    // A public post exists under a tag nobody follows — presence of content is
    // never on its own a reason to recommend its author.
    await createPost(id('stranger'), { hashtags: [id('unfollowed')] });

    expect(await service.getContentCandidates(VIEWER)).toEqual([]);
  });

  it('returns [] for an empty viewer id without doing any work', async () => {
    await followHashtag(id('rust'));
    await createPost(id('tag-author'), { hashtags: [id('rust')] });

    expect(await service.getContentCandidates('')).toEqual([]);
    // The guard is a short-circuit, not a filter: no privacy round trip either.
    expect(mocks.loadPrivacyState).not.toHaveBeenCalled();
  });
});

describe('hashtag affinity', () => {
  /**
   * `POST /entity-follows` canonicalizes a followed tag with the same
   * `normalizeHashtag` that derives `Post.hashtags`, so the stored ids go into
   * the aggregation UNCHANGED. This service used to `.trim().toLowerCase()` them
   * — a second rule, and one that never matched the punctuation-stripping half
   * of the canonical form.
   *
   * The fixtures are deliberately NOT canonical: a canonical tag is a fixpoint
   * of every normalization, so a matching author would prove nothing. Only a
   * value re-normalizing WOULD change can observe the step's absence — hence the
   * uppercase and the surrounding spaces, and hence the control author who posts
   * under the NORMALIZED spelling and must NOT match.
   */
  it('matches followed tags as stored, without re-normalizing them', async () => {
    const storedUpper = `${NS}-Rust`;
    const storedPadded = ` ${NS}-go-lang `;
    await followHashtag(storedUpper);
    await followHashtag(storedPadded);

    await createPost(id('as-stored-upper'), { hashtags: [storedUpper] });
    await createPost(id('as-stored-padded'), { hashtags: [storedPadded] });
    // The tag a re-normalizing service would have searched for instead.
    await createPost(id('normalized-only'), { hashtags: [`${NS}-rust`] });

    const result = await service.getContentCandidates(VIEWER);

    expect(ourIds(result).sort()).toEqual([id('as-stored-padded'), id('as-stored-upper')]);
  });

  it('scores an author covering two followed tags above one covering a single tag', async () => {
    await followHashtag(id('rust'));
    await followHashtag(id('go'));

    // a1 covers BOTH followed tags across TWO posts, one of which carries both —
    // so the tag join emits THREE (post, tag) pairs for two posts. That gap is
    // what separates "how many posts" from "how many matches"; a volume bonus
    // counting pairs would read 3 here.
    await createPost(id('a1'), { hashtags: [id('rust'), id('go')] });
    await createPost(id('a1'), { hashtags: [id('go')] });
    // a2 covers one tag, once.
    await createPost(id('a2'), { hashtags: [id('rust')] });

    const result = await service.getContentCandidates(VIEWER);

    expect(ourIds(result)).toEqual([id('a1'), id('a2')]);
    // coverage(2 distinct tags) * 1 + volume bonus(2 posts).
    expect(weightOf(result, id('a1'))).toBeCloseTo(2 + VOLUME_BONUS_2_POSTS, 10);
    // coverage(1 tag) * 1 + volume bonus(1 post) — strictly lower.
    expect(weightOf(result, id('a2'))).toBeCloseTo(1 + VOLUME_BONUS_1_POST, 10);
    expect(ours(result)[0].reasons).toEqual(['hashtag']);
  });
});

describe('engagement affinity', () => {
  it('picks the authors of liked, replied-to and boosted posts', async () => {
    const liked = await createPost(id('author-like'));
    const repliedTo = await createPost(id('author-reply'));
    const boosted = await createPost(id('author-boost'));

    await likePost(liked.id);
    await createPost(VIEWER, { parentPostId: repliedTo.id });
    await createPost(VIEWER, {
      type: PostType.BOOST,
      boostOf: boosted.id,
      content: { variants: [] },
    });

    const result = await service.getContentCandidates(VIEWER);

    // A boost is weighted above a reply, a reply above a like.
    expect(ourIds(result)).toEqual([id('author-boost'), id('author-reply'), id('author-like')]);
    expect(weightOf(result, id('author-boost'))).toBe(5);
    expect(weightOf(result, id('author-reply'))).toBe(4);
    expect(weightOf(result, id('author-like'))).toBe(3);
    for (const candidate of ours(result)) {
      expect(candidate.reasons).toEqual(['engagement']);
    }
  });

  /**
   * A like taken on the reels surface is mostly about the CONTENT, so it must
   * contribute only a fraction of the normal like weight toward its author
   * becoming a FOLLOW candidate. Both authors are reached by exactly one like,
   * so the surface is the only thing separating them.
   */
  it('discounts a video-surface like against a normal-surface like', async () => {
    const fromHome = await createPost(id('author-normal'));
    const fromReels = await createPost(id('author-video'));
    await likePost(fromHome.id, 'for_you');
    await likePost(fromReels.id, 'videos');

    const result = await service.getContentCandidates(VIEWER);

    expect(ourIds(result)).toEqual([id('author-normal'), id('author-video')]);
    expect(weightOf(result, id('author-normal'))).toBe(3);
    expect(weightOf(result, id('author-video'))).toBeCloseTo(3 * VIDEO_FACTOR, 10);
  });

  it('treats a like with no source (legacy) as a full-weight, non-video like', async () => {
    const legacy = await createPost(id('author-legacy'));
    const fromReels = await createPost(id('author-video'));
    await likePost(legacy.id);
    await likePost(fromReels.id, 'videos');

    const result = await service.getContentCandidates(VIEWER);

    expect(weightOf(result, id('author-legacy'))).toBe(3);
    expect(weightOf(result, id('author-video'))).toBeCloseTo(3 * VIDEO_FACTOR, 10);
  });

  it('outranks hashtag affinity for the same amount of evidence', async () => {
    await followHashtag(id('rust'));
    await createPost(id('tag-only'), { hashtags: [id('rust')] });
    const liked = await createPost(id('engaged'));
    await likePost(liked.id);

    const result = await service.getContentCandidates(VIEWER);

    expect(ourIds(result)).toEqual([id('engaged'), id('tag-only')]);
    expect(weightOf(result, id('engaged'))).toBe(3);
    expect(weightOf(result, id('tag-only'))).toBeCloseTo(1 + VOLUME_BONUS_1_POST, 10);
  });

  it('sums both signals for an author hit by hashtag AND engagement', async () => {
    await followHashtag(id('rust'));
    const tagged = await createPost(id('both'), { hashtags: [id('rust')] });
    await likePost(tagged.id);

    const result = await service.getContentCandidates(VIEWER);

    expect(ourIds(result)).toEqual([id('both')]);
    expect(weightOf(result, id('both'))).toBeCloseTo(1 + VOLUME_BONUS_1_POST + 3, 10);
    expect(ours(result)[0].reasons).toEqual(['engagement', 'hashtag']);
  });

  it('resolves engagement authors only from published public target posts', async () => {
    const published = await createPost(id('public-author'));
    const restricted = await createPost(id('private-author'), {
      visibility: PostVisibility.PRIVATE,
    });
    const draft = await createPost(id('draft-author'), { status: 'draft' });
    await likePost(published.id);
    await likePost(restricted.id);
    await likePost(draft.id);

    const result = await service.getContentCandidates(VIEWER);

    expect(ourIds(result)).toEqual([id('public-author')]);
    expect(weightOf(result, id('public-author'))).toBe(3);
  });
});

describe('exclusions and profile access', () => {
  it('excludes self and blocked/muted/restricted users', async () => {
    mocks.loadPrivacyState.mockResolvedValue({
      blockedUserIds: new Set([id('blocked')]),
      mutedUserIds: new Set([id('muted')]),
      restrictedUserIds: new Set([id('restricted')]),
      excludedUserIds: new Set([id('blocked'), id('muted'), id('restricted')]),
    });
    await followHashtag(id('rust'));
    for (const author of [id('blocked'), id('muted'), id('restricted'), VIEWER, id('good')]) {
      await createPost(author, { hashtags: [id('rust')] });
    }

    const result = await service.getContentCandidates(VIEWER, { oxyClient: scopedOxyClient });

    expect(ourIds(result)).toEqual([id('good')]);
    expect(weightOf(result, id('good'))).toBeCloseTo(1 + VOLUME_BONUS_1_POST, 10);
    // The per-request client must reach the Oxy-owned relation read; the service
    // must not silently fall back to the service credential.
    expect(mocks.loadPrivacyState).toHaveBeenCalledWith(VIEWER, {
      oxyClient: scopedOxyClient,
      includeRestricted: true,
    });
  });

  it('filters private and followers-only candidates unless the viewer follows them', async () => {
    await followHashtag(id('rust'));
    for (const author of [
      id('public-author'),
      id('private-author'),
      id('followers-author'),
      id('followed-private-author'),
    ]) {
      await createPost(author, { hashtags: [id('rust')] });
    }
    await setProfileVisibility([id('private-author'), id('followed-private-author')], 'private');
    await setProfileVisibility([id('followers-author')], 'followers_only');
    mocks.getFollowingIdSet.mockResolvedValue(new Set([id('followed-private-author')]));

    const result = await service.getContentCandidates(VIEWER, { oxyClient: scopedOxyClient });

    expect(ourIds(result).sort()).toEqual([id('followed-private-author'), id('public-author')]);
    expect(mocks.getFollowingIdSet).toHaveBeenCalledTimes(1);
    expect(mocks.getFollowingIdSet).toHaveBeenCalledWith(VIEWER, scopedOxyClient);
  });

  it('batches the follow-graph read across every protected candidate', async () => {
    await followHashtag(id('rust'));
    const protectedAuthors = Array.from({ length: 75 }, (_, index) => id(`private-author-${index}`));
    await Promise.all(
      protectedAuthors.map((author) => createPost(author, { hashtags: [id('rust')] })),
    );
    await setProfileVisibility(protectedAuthors, 'private');
    mocks.getFollowingIdSet.mockResolvedValue(new Set([id('private-author-7')]));

    const result = await service.getContentCandidates(VIEWER, { limit: 5 });

    // 75 protected candidates, exactly one of them followed — and ONE graph read.
    expect(ourIds(result)).toEqual([id('private-author-7')]);
    expect(mocks.getFollowingIdSet).toHaveBeenCalledTimes(1);
    expect(mocks.getFollowingIdSet).toHaveBeenCalledWith(VIEWER, undefined);
  });
});

describe('the candidate cap', () => {
  it('returns no more candidates than the caller asked for, strongest first', async () => {
    await followHashtag(id('rust'));
    // Distinct post volumes so the ordering is total and the truncation is
    // observable rather than arbitrary.
    for (let index = 0; index < 8; index += 1) {
      for (let post = 0; post <= index; post += 1) {
        await createPost(id(`ranked-${index}`), { hashtags: [id('rust')] });
      }
    }

    const result = await service.getContentCandidates(VIEWER, { limit: 3 });

    expect(result).toHaveLength(3);
    expect(ourIds(result)).toEqual([id('ranked-7'), id('ranked-6'), id('ranked-5')]);
  });
});

describe('the per-viewer cache', () => {
  it('serves a cached result without consulting the database', async () => {
    // Fixtures that WOULD produce a different answer, so serving the cached one
    // is the only way the assertion can hold.
    await followHashtag(id('rust'));
    await createPost(id('uncached-author'), { hashtags: [id('rust')] });

    const cached = [{ userId: id('cached'), weight: 5, reasons: ['engagement'] }];
    mocks.redisGet.mockResolvedValue(JSON.stringify(cached));
    mocks.getRedisClient.mockReturnValue({
      isReady: true,
      get: mocks.redisGet,
      set: mocks.redisSet,
    });

    const result = await service.getContentCandidates(VIEWER);

    expect(result).toEqual(cached);
    // A hit short-circuits before any signal runs — including the privacy read.
    expect(mocks.loadPrivacyState).not.toHaveBeenCalled();
  });
});

describe('the soft-fail contract', () => {
  /**
   * The service is ADDITIVE: `RecommendationService` proceeds with no boosts on
   * any error, and every signal here degrades to empty rather than throwing. An
   * unreachable database is the widest version of that — every Postgres-backed
   * signal fails at once, and the profile-ACL filter fails CLOSED on top.
   *
   * The first half is the vacuity floor: the same fixtures must produce a real
   * candidate while the pool is open, or `[]` would prove nothing.
   */
  it('degrades to [] when the database is unreachable instead of throwing', async () => {
    await followHashtag(id('rust'));
    await createPost(id('tag-author'), { hashtags: [id('rust')] });

    expect(ourIds(await service.getContentCandidates(VIEWER))).toEqual([id('tag-author')]);

    await closePostgres();
    try {
      await expect(service.getContentCandidates(VIEWER)).resolves.toEqual([]);
    } finally {
      db = await connectPostgres();
    }
  });
});

describe('the behavior-derived signals', () => {
  it('uses preferredAuthors (maintained relationship weight) as the strongest signal', async () => {
    // A maxed-out preferred author (weight 1.0) must outrank a hashtag-only
    // author covering one followed tag.
    await seedBehavior(behavior({ preferredAuthors: [{ authorId: id('fav'), weight: 1.0 }] }));
    await followHashtag(id('rust'));
    await createPost(id('tag-only'), { hashtags: [id('rust')] });

    const result = await service.getContentCandidates(VIEWER);

    expect(ourIds(result)).toEqual([id('fav'), id('tag-only')]);
    expect(weightOf(result, id('fav'))).toBeCloseTo(6, 10);
    expect(weightOf(result, id('tag-only'))).toBeCloseTo(1 + VOLUME_BONUS_1_POST, 10);
    expect(ours(result)[0].reasons).toEqual(['preferred-author']);
  });

  it('scales the preferred-author contribution by the maintained weight', async () => {
    await seedBehavior(
      behavior({
        preferredAuthors: [
          { authorId: id('strong'), weight: 0.9 },
          { authorId: id('weak'), weight: 0.1 },
        ],
      }),
    );

    const result = await service.getContentCandidates(VIEWER);

    expect(ourIds(result)).toEqual([id('strong'), id('weak')]);
    expect(weightOf(result, id('strong'))).toBeCloseTo(0.9 * 6, 10);
    expect(weightOf(result, id('weak'))).toBeCloseTo(0.1 * 6, 10);
  });

  it("picks authors posting under the viewer's preferred topics, scaled per topic", async () => {
    await seedBehavior(
      behavior({
        preferredTopics: [
          { topic: id('machine-learning'), weight: 0.8 },
          { topic: id('rust'), weight: 0.3 },
        ],
      }),
    );
    // No followed hashtags — this is inferred interest, not an explicit follow.
    for (let index = 0; index < 3; index += 1) {
      await createPost(id('ml-author'), {
        postClassification: { topics: [id('machine-learning')] },
      });
    }
    await createPost(id('rust-author'), { postClassification: { topics: [id('rust')] } });

    const result = await service.getContentCandidates(VIEWER);

    expect(ourIds(result)).toEqual([id('ml-author'), id('rust-author')]);
    // per-topic weight * 1 + volume bonus. The strongly-preferred topic (0.8)
    // outweighs the weakly-preferred one (0.3) even before the volume bonus.
    expect(weightOf(result, id('ml-author'))).toBeCloseTo(0.8 + VOLUME_BONUS_3_POSTS, 10);
    expect(weightOf(result, id('rust-author'))).toBeCloseTo(0.3 + VOLUME_BONUS_1_POST, 10);
    expect(ours(result)[0].reasons).toEqual(['topic']);
  });

  it('strips hidden topics from the topic-affinity input', async () => {
    // `crypto` is the STRONGEST preference and also hidden: "more of what you
    // told us to stop showing you" must never come back as a recommendation.
    await seedBehavior(
      behavior({
        preferredTopics: [
          { topic: id('crypto'), weight: 0.9 },
          { topic: id('rust'), weight: 0.5 },
        ],
        hiddenTopics: [id('crypto')],
      }),
    );
    await createPost(id('crypto-author'), { postClassification: { topics: [id('crypto')] } });
    await createPost(id('rust-author'), { postClassification: { topics: [id('rust')] } });

    const result = await service.getContentCandidates(VIEWER);

    expect(ourIds(result)).toEqual([id('rust-author')]);
    expect(weightOf(result, id('rust-author'))).toBeCloseTo(0.5 + VOLUME_BONUS_1_POST, 10);
  });

  it('excludes behavior-tracked hidden/muted/blocked authors from candidates', async () => {
    await seedBehavior(
      behavior({
        // The hidden author is ALSO the strongest preferred author — suppression
        // must win over affinity.
        preferredAuthors: [{ authorId: id('hidden'), weight: 1.0 }],
        hiddenAuthors: [id('hidden')],
        mutedAuthors: [id('muted')],
        blockedAuthors: [id('blocked')],
      }),
    );
    await followHashtag(id('rust'));
    for (const author of [id('hidden'), id('muted'), id('blocked'), id('good')]) {
      await createPost(author, { hashtags: [id('rust')] });
    }

    const result = await service.getContentCandidates(VIEWER);

    expect(ourIds(result)).toEqual([id('good')]);
    expect(weightOf(result, id('good'))).toBeCloseTo(1 + VOLUME_BONUS_1_POST, 10);
  });

  it('degrades gracefully when the behavior load throws (no behavior signals)', async () => {
    mocks.behaviorLoadError = new Error('behaviour read failed');
    // Hashtag affinity still produces a candidate — the behavior-derived signals
    // simply contribute nothing.
    await followHashtag(id('rust'));
    await createPost(id('tag-author'), { hashtags: [id('rust')] });

    const result = await service.getContentCandidates(VIEWER);

    expect(ourIds(result)).toEqual([id('tag-author')]);
    expect(weightOf(result, id('tag-author'))).toBeCloseTo(1 + VOLUME_BONUS_1_POST, 10);
  });
});
