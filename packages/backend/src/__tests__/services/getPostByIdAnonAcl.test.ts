/**
 * Anonymous-viewer ACL proof for `GET /posts/:id` (getPostById).
 *
 * The route is public (anonymous discovery / SEO / fediverse), so the ONLY thing
 * preventing a private post from leaking to a logged-out viewer is the
 * `PostHydrationService` ACL running with `viewerId === undefined`. getPostById
 * returns 404 whenever hydration drops the post (empty result). Each visibility
 * case drives the REAL `hydratePosts` path with the same options getPostById
 * uses, and asserts that ONLY a public+published post from a public-profile
 * author survives.
 *
 * The posts and the author's profile-visibility setting are REAL ROWS. They used
 * to be a `postRow()` literal and a `userSettingsFind.mockReturnValue`, which
 * made the profile-visibility half of this gate a test of the mock: the ACL asks
 * `user_settings` a question, and the mock answered it regardless of whether the
 * query would have found anything. That is the failure mode a security gate
 * cannot afford — a lookup that silently returns nothing reads as "public".
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostVisibility } from '@mention/shared-types';
import type { CachedUserSummary } from '../../services/userSummaryCache';

const { getUsersByIds, cacheStore } = vi.hoisted(() => ({
  getUsersByIds: vi.fn(),
  cacheStore: new Map<string, CachedUserSummary>(),
}));

// Oxy owns identity and is a remote service, so it stays mocked. Everything
// Mention stores is real.
vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({
    getUserById: vi.fn(),
    getUserFollowing: vi.fn(async () => []),
    getUserFollowers: vi.fn(async () => []),
  }),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUsersByIds,
    getLinkPreviews: vi.fn(async () => ({})),
    getFileDownloadUrl: (id: string) => `https://cdn.test/${id}`,
  }),
}));

vi.mock('../../utils/privacyHelpers', () => ({
  getBlockedUserIds: vi.fn(async () => []),
  getRestrictedUserIds: vi.fn(async () => []),
  extractFollowingIds: vi.fn(() => []),
  extractFollowersIds: vi.fn(() => []),
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

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { userSettings } from '../../db/schema/userProfile';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import { PostHydrationService } from '../../services/PostHydrationService';
import type { PostRecord } from '../../db/posts/postRecord';

const scope = postScope('anon-acl');
const AUTHOR_ID = scope.user('author');

describe('getPostById ACL — anonymous viewer cannot see non-public posts', () => {
  let service: PostHydrationService;

  /** Mirror getPostById: hydrate a single row as an anonymous viewer. */
  async function hydrateAsAnon(post: PostRecord) {
    return service.hydratePosts([post], {
      viewerId: undefined,
      oxyClient: {
        getUsersByIds,
        getLinkPreviews: vi.fn(async () => ({})),
        getFileDownloadUrl: (id: string) => `https://cdn.test/${id}`,
      } as never,
      maxDepth: 2,
      includeLinkMetadata: true,
    });
  }

  async function setProfileVisibility(visibility: string): Promise<void> {
    await getDb()
      .insert(userSettings)
      .values({ oxyUserId: AUTHOR_ID, privacyProfileVisibility: visibility })
      .onConflictDoUpdate({
        target: userSettings.oxyUserId,
        set: { privacyProfileVisibility: visibility },
      });
  }

  beforeAll(async () => {
    await connectPostgres();
  });

  beforeEach(async () => {
    cacheStore.clear();
    getUsersByIds.mockReset();
    getUsersByIds.mockResolvedValue([
      {
        id: AUTHOR_ID,
        username: 'author',
        name: { displayName: 'Author' },
        badges: [],
        verified: false,
        isVerified: false,
      },
    ]);
    service = new PostHydrationService();
    await setProfileVisibility('public');
  });

  afterEach(async () => {
    await clearPostScope(scope);
    await getDb().delete(userSettings).where(eq(userSettings.oxyUserId, AUTHOR_ID));
  });

  afterAll(async () => {
    await closePostgres();
  });

  it('RETURNS a public+published post (public-profile author)', async () => {
    const post = await seedPost(scope, { oxyUserId: AUTHOR_ID });

    const result = await hydrateAsAnon(post);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(post.id);
  });

  it('DROPS a private post (→ getPostById 404)', async () => {
    const post = await seedPost(scope, {
      oxyUserId: AUTHOR_ID,
      visibility: PostVisibility.PRIVATE,
    });

    expect(await hydrateAsAnon(post)).toHaveLength(0);
  });

  it('DROPS a followers-only post (→ getPostById 404)', async () => {
    const post = await seedPost(scope, {
      oxyUserId: AUTHOR_ID,
      visibility: PostVisibility.FOLLOWERS_ONLY,
    });

    expect(await hydrateAsAnon(post)).toHaveLength(0);
  });

  it('DROPS a federated followers-only post (→ getPostById 404)', async () => {
    // `mapApVisibility` turns a Note that is not publicly addressed into
    // `followers_only`, so "federated" does NOT imply public. The ACL used to
    // bypass every federated post, which served a remote author's private post
    // to anyone who asked for it by id.
    const post = await seedPost(scope, {
      oxyUserId: AUTHOR_ID,
      visibility: PostVisibility.FOLLOWERS_ONLY,
      federation: {
        activityId: 'https://remote.test/posts/private',
        actorUri: 'https://remote.test/users/author',
      },
    });

    expect(await hydrateAsAnon(post)).toHaveLength(0);
  });

  it('DROPS an unpublished (draft) post (→ getPostById 404)', async () => {
    const post = await seedPost(scope, { oxyUserId: AUTHOR_ID, status: 'draft' });

    expect(await hydrateAsAnon(post)).toHaveLength(0);
  });

  it('DROPS a scheduled post (→ getPostById 404)', async () => {
    const post = await seedPost(scope, { oxyUserId: AUTHOR_ID, status: 'scheduled' });

    expect(await hydrateAsAnon(post)).toHaveLength(0);
  });

  it('DROPS a public post whose author has a PRIVATE profile (→ getPostById 404)', async () => {
    // Post-level visibility is NOT sufficient: profile visibility is a separate
    // setting and this is the only place it is enforced for an anonymous read.
    await setProfileVisibility('private');
    const post = await seedPost(scope, { oxyUserId: AUTHOR_ID });

    expect(await hydrateAsAnon(post)).toHaveLength(0);
  });

  it('DROPS a public post whose author has a FOLLOWERS-ONLY profile (→ getPostById 404)', async () => {
    await setProfileVisibility('followers_only');
    const post = await seedPost(scope, { oxyUserId: AUTHOR_ID });

    expect(await hydrateAsAnon(post)).toHaveLength(0);
  });

  it('RETURNS a public post from an author with NO settings row at all', async () => {
    // The absence of a row means "never configured", which must read as public.
    // Worth its own case because the ported query returns no row rather than a
    // document with empty `privacy`, and defaulting the wrong way here would
    // hide every post by every author who never opened settings.
    await getDb().delete(userSettings).where(eq(userSettings.oxyUserId, AUTHOR_ID));
    const post = await seedPost(scope, { oxyUserId: AUTHOR_ID });

    expect(await hydrateAsAnon(post)).toHaveLength(1);
  });
});
