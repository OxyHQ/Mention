/**
 * `engagement.quotes` — the one engagement counter Mention does NOT denormalize
 * onto `post.stats`. It is counted on read off the `quote_of` index, so the whole
 * contract is "only when the caller asks":
 *
 *  - `includeQuoteCounts: true` (the post-detail endpoints) → one aggregate for
 *    the whole hydrated batch, `quotes` present on every post;
 *  - default (every feed request) → NO query at all, `quotes` absent.
 *
 * The counts come from REAL quote rows. Under the previous mock the aggregate's
 * result was whatever `mockResolvedValue` said, so the test could not tell the
 * grouped query apart from one that matched nothing — the exact failure the
 * counter would exhibit in production, since a miss is legitimately read as zero.
 *
 * The second half stays a CALL assertion, and deliberately so: the guarantee is
 * "no query is issued", which has no observable trace in the response. The spy
 * wraps the real `countQuotesOf` and calls through, so the data path is still
 * the real one — only the fact of the call is instrumented.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostType } from '@mention/shared-types';
import type { CachedUserSummary } from '../../services/userSummaryCache';

const { getUserById, getUsersByIds, cacheStore } = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getUsersByIds: vi.fn(),
  cacheStore: new Map<string, CachedUserSummary>(),
}));

// Oxy owns identity and is a remote service; it stays mocked. Posts do not.
vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({
    getUserById,
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

import { closePostgres, connectPostgres } from '../../db/postgres';
import * as postRepository from '../../db/posts/postRepository';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import { PostHydrationService } from '../../services/PostHydrationService';

const scope = postScope('quote-counts');
const AUTHOR = scope.user('author');

describe('PostHydrationService — quote counts', () => {
  let service: PostHydrationService;
  // Spied on the module NAMESPACE, not replaced: the real query still runs, and
  // the spy exists only so the "no query at all" half has something to observe.
  const countQuotesOfSpy = vi.spyOn(postRepository, 'countQuotesOf');

  beforeAll(async () => {
    await connectPostgres();
  });

  beforeEach(() => {
    cacheStore.clear();
    getUserById.mockReset();
    getUsersByIds.mockReset();
    countQuotesOfSpy.mockClear();

    getUsersByIds.mockResolvedValue([
      { id: AUTHOR, username: 'author', name: { displayName: 'Author' }, badges: [], verified: false },
    ]);
    getUserById.mockResolvedValue(null);

    service = new PostHydrationService();
  });

  afterEach(async () => {
    await clearPostScope(scope);
  });

  afterAll(async () => {
    await closePostgres();
  });

  /** A quote is an ordinary post carrying `quoteOf`. */
  async function seedQuotes(quoteOf: string, count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await seedPost(scope, { oxyUserId: AUTHOR, quoteOf, type: PostType.TEXT });
    }
  }

  it('counts quotes per post in ONE query when the caller asks for them', async () => {
    const quoted = await seedPost(scope, { oxyUserId: AUTHOR });
    const alsoQuoted = await seedPost(scope, { oxyUserId: AUTHOR });
    await seedQuotes(quoted.id, 2);
    await seedQuotes(alsoQuoted.id, 3);
    // A reply is NOT a quote: it references its parent through `parent_post_id`,
    // so it must not reach the count. Under a mock this row did not exist at all.
    await seedPost(scope, { oxyUserId: AUTHOR, parentPostId: quoted.id, isReply: true });

    const hydrated = await service.hydratePosts([quoted, alsoQuoted], {
      maxDepth: 0,
      includeQuoteCounts: true,
    });

    expect(hydrated.map((post) => post.engagement.quotes)).toEqual([2, 3]);
    expect(countQuotesOfSpy).toHaveBeenCalledTimes(1);
    expect(countQuotesOfSpy).toHaveBeenCalledWith([quoted.id, alsoQuoted.id]);
  });

  it('reports zero for a post nothing quotes', async () => {
    const quoted = await seedPost(scope, { oxyUserId: AUTHOR });
    const unquoted = await seedPost(scope, { oxyUserId: AUTHOR });
    await seedQuotes(quoted.id, 1);

    const hydrated = await service.hydratePosts([unquoted], {
      maxDepth: 0,
      includeQuoteCounts: true,
    });

    // Zero, not absent: a caller that asked always gets a number.
    expect(hydrated[0].engagement.quotes).toBe(0);
  });

  it('runs NO query and omits the field when the caller does not ask', async () => {
    const quoted = await seedPost(scope, { oxyUserId: AUTHOR });
    await seedQuotes(quoted.id, 1);

    const [hydrated] = await service.hydratePosts([quoted], { maxDepth: 0 });

    // The quote row exists, so an ungated query would have produced 1 — the
    // field being absent is therefore about the gate, not about missing data.
    expect(hydrated.engagement.quotes).toBeUndefined();
    expect(countQuotesOfSpy).not.toHaveBeenCalled();
  });
});
