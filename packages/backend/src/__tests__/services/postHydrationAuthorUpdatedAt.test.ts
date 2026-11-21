import { lookupManyOf } from '../helpers/oxyLookup';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentAccessInput } from '@oxy.so/contracts';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearFederationScope, federationScope, seedPost } from '../helpers/federationFixtures';
import type { CachedUserSummary } from '../../services/userSummaryCache';
import type { PostRecord } from '../../db/posts/postRecord';

/**
 * Every embedded author carries Oxy's `updatedAt`, the time the account last
 * changed, so a client that merges users by id can keep the newer copy. Runs the
 * real `hydratePosts` against seeded rows: the post's `user`, its `authors`, and
 * the boosted original's author, and then a profile edit that reaches the next
 * hydration with a later `updatedAt`.
 */

const scope = federationScope('hydration-author-updated-at');
const BOOSTER_OXY_ID = scope.user('booster');
const AUTHOR_OXY_ID = scope.user('author');

const BEFORE_EDIT = '2026-11-01T10:00:00.000Z';
const AFTER_EDIT = '2026-11-20T18:30:00.000Z';

const { getUserById, getUsersByIds, contentAccessBatch, cacheStore } = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getUsersByIds: vi.fn(),
  contentAccessBatch: vi.fn(),
  cacheStore: new Map<string, CachedUserSummary>(),
}));

vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({
    users: { get: getUserById },
    follows: { following: vi.fn(async () => []), followers: vi.fn(async () => []) },
  }),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: () => undefined,
  callerOxyUser: () => undefined,
  callerAccountAccess: () => undefined,
  getServiceOxyClient: () => ({
    safety: { contentAccessBatch },
    users: {
      getMany: getUsersByIds,
      lookupMany: lookupManyOf((ids: string[]) => getUsersByIds(ids)),
    },
    assets: { publicUrl: (id: string) => `https://cdn.test/${id}` },
  }),
}));

vi.mock('../../utils/privacyHelpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/privacyHelpers')>()),
  getBlockedUserIds: vi.fn(async () => []),
  getRestrictedUserIds: vi.fn(async () => []),
}));

vi.mock('../../services/moderation/crowdSourceClient', () => ({
  getCrowdSourceClient: () => ({ communityNotes: { shown: async () => [] } }),
}));

/** The shared summary cache, in memory; `invalidate` is what an Oxy identity broadcast runs. */
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
  invalidate: vi.fn(async (ids: string[]) => {
    for (const id of ids) cacheStore.delete(id);
  }),
}));

import {
  PostHydrationService,
  resetOxyUserFailureMemory,
} from '../../services/PostHydrationService';
import { invalidate as invalidateUserSummaries } from '../../services/userSummaryCache';

function oxyUser(id: string, username: string, displayName: string, updatedAt: string) {
  return { id, username, name: { displayName }, avatar: `${username}-avatar`, updatedAt };
}

async function seedOriginal(): Promise<PostRecord> {
  return seedPost(scope, {
    oxyUserId: AUTHOR_OXY_ID,
    authorship: [{ oxyUserId: AUTHOR_OXY_ID, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ tag: 'en', source: 'author', text: 'an original note' }] },
    createdAt: new Date('2026-10-31T00:00:00Z'),
  });
}

async function seedBoost(originalId: string): Promise<PostRecord> {
  return seedPost(scope, {
    oxyUserId: BOOSTER_OXY_ID,
    authorship: [{ oxyUserId: BOOSTER_OXY_ID, role: 'owner', status: 'accepted' }],
    type: PostType.BOOST,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: {},
    boostOf: originalId,
    createdAt: new Date('2026-11-01T00:00:00Z'),
  });
}

describe('PostHydrationService — embedded authors carry updatedAt', () => {
  let service: PostHydrationService;

  beforeAll(async () => {
    await connectPostgres();
  });

  afterAll(async () => {
    await closePostgres();
  });

  beforeEach(() => {
    cacheStore.clear();
    resetOxyUserFailureMemory();
    getUserById.mockReset();
    getUsersByIds.mockReset();
    contentAccessBatch.mockReset();
    contentAccessBatch.mockImplementation(async ({ items }: { items: ContentAccessInput[] }) => ({
      items: items.map((item) => ({
        resourceId: item.resourceId,
        decision: { allowed: true, reason: 'allowed', policyVersion: '2' },
      })),
    }));
    getUsersByIds.mockResolvedValue([
      oxyUser(BOOSTER_OXY_ID, 'booster', 'Booster', BEFORE_EDIT),
      oxyUser(AUTHOR_OXY_ID, 'author', 'Author', BEFORE_EDIT),
    ]);
    service = new PostHydrationService();
  });

  afterEach(async () => {
    await clearFederationScope(scope);
  });

  async function hydrate(post: PostRecord) {
    const [hydrated] = await service.hydratePosts([post], {
      maxDepth: 1,
      safetyRequester: { accessToken: null },
      includeLinkMetadata: false,
      includeFullMetadata: false,
    });
    return hydrated;
  }

  it('stamps the post author, its byline and the boosted original author', async () => {
    const original = await seedOriginal();
    const boost = await seedBoost(original.id);

    const post = await hydrate(original);
    expect(post.user).toMatchObject({ id: AUTHOR_OXY_ID, updatedAt: BEFORE_EDIT });
    expect(post.authors.map((author) => author.updatedAt)).toEqual([BEFORE_EDIT]);

    const boosted = await hydrate(boost);
    expect(boosted.user).toMatchObject({ id: BOOSTER_OXY_ID, updatedAt: BEFORE_EDIT });
    expect(boosted.boost?.originalPost?.user).toMatchObject({
      id: AUTHOR_OXY_ID,
      updatedAt: BEFORE_EDIT,
    });
  });

  it('carries the later updatedAt, with the edited profile, once Oxy reports an edit', async () => {
    const original = await seedOriginal();
    expect((await hydrate(original)).user).toMatchObject({
      name: { displayName: 'Author' },
      updatedAt: BEFORE_EDIT,
    });

    // The author renames themself in Oxy. Oxy bumps `updatedAt` on the write and
    // broadcasts the change, which evicts the cached summary.
    getUsersByIds.mockResolvedValue([oxyUser(AUTHOR_OXY_ID, 'author', 'Renamed', AFTER_EDIT)]);
    await invalidateUserSummaries([AUTHOR_OXY_ID]);

    const edited = await hydrate(original);
    expect(edited.user).toMatchObject({ name: { displayName: 'Renamed' }, updatedAt: AFTER_EDIT });
    expect(Date.parse(edited.user.updatedAt ?? '')).toBeGreaterThan(Date.parse(BEFORE_EDIT));
  });

  it('leaves the placeholder for an author Oxy cannot resolve without updatedAt', async () => {
    const original = await seedOriginal();
    getUsersByIds.mockResolvedValue([]);

    const post = await hydrate(original);
    expect(post.user.username).toBe('');
    expect(post.user).not.toHaveProperty('updatedAt');
  });
});
