import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CachedUserSummary } from '../../services/userSummaryCache';

/**
 * `importedFrom` on a post DTO — "Originally posted on Mastodon".
 *
 * The rows are real: a real imported post, a real `post_imports` ledger row, and
 * a native post beside it in the SAME batch, because the claim is about which
 * post of a page carries the field. A batch holding only the imported post would
 * pass just as well against a hydrator that stamped every post as imported.
 *
 * The content warning rides the same read: a native post has no CW text of its
 * own, so an imported one's label comes from the ledger into
 * `metadata.spoilerText`, the field the frontend already gates the body on.
 */

const { getUsersByIds, cacheStore } = vi.hoisted(() => ({
  getUsersByIds: vi.fn(),
  cacheStore: new Map<string, CachedUserSummary>(),
}));

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
    getClarityDocuments: vi.fn(async () => ({})),
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

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { postImports } from '../../db/schema/imports';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import { PostHydrationService } from '../../services/PostHydrationService';

const scope = postScope('hydration-imported-from');
const AUTHOR_ID = scope.user('author');

function hydrate(posts: object[]) {
  return new PostHydrationService().hydratePosts(posts, {
    maxDepth: 1,
    oxyClient: {
      getUsersByIds,
      getClarityDocuments: vi.fn(async () => ({})),
      getFileDownloadUrl: (id: string) => `https://cdn.test/${id}`,
    } as never,
  });
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  cacheStore.clear();
  getUsersByIds.mockReset();
  getUsersByIds.mockImplementation(async (ids: string[]) =>
    ids.map((id) => ({ id, username: id, name: { displayName: id }, badges: [], verified: false })),
  );
});

afterEach(async () => {
  await clearPostScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('PostHydrationService — importedFrom', () => {
  it('names the source platform on the imported post and on no other', async () => {
    const imported = await seedPost(scope, { oxyUserId: AUTHOR_ID });
    const native = await seedPost(scope, { oxyUserId: AUTHOR_ID });
    await getDb().insert(postImports).values({
      postId: imported.id,
      oxyUserId: AUTHOR_ID,
      platform: 'mastodon',
      sourceId: `${scope.name}-1`,
      sourceUrl: 'https://mastodon.example/@author/1',
      importBatchId: `${scope.name}-batch`,
    });

    const hydrated = await hydrate([imported, native]);
    const byId = new Map(hydrated.map((post) => [post.id, post]));

    expect(byId.get(imported.id)?.importedFrom).toEqual({
      platform: 'mastodon',
      sourceUrl: 'https://mastodon.example/@author/1',
    });
    expect(byId.get(native.id)).toBeDefined();
    expect(byId.get(native.id)?.importedFrom).toBeUndefined();
    // No CW was imported, so none is invented.
    expect(byId.get(imported.id)?.metadata.spoilerText).toBeUndefined();
  });

  it("renders an imported post's content warning as its spoiler label", async () => {
    const imported = await seedPost(scope, { oxyUserId: AUTHOR_ID });
    await getDb().insert(postImports).values({
      postId: imported.id,
      oxyUserId: AUTHOR_ID,
      platform: 'bluesky',
      sourceId: `${scope.name}-2`,
      sourceUrl: 'https://bsky.app/profile/author/post/2',
      contentWarning: 'spoilers for the finale',
      importBatchId: `${scope.name}-batch`,
    });

    const [hydrated] = await hydrate([imported]);
    expect(hydrated?.metadata.spoilerText).toBe('spoilers for the finale');
    expect(hydrated?.importedFrom?.platform).toBe('bluesky');
  });
});
