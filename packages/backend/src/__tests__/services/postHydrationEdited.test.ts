import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CachedUserSummary } from '../../services/userSummaryCache';

/**
 * THE EDITED MARKER ON A POST DTO.
 *
 * `posts.is_edited` has always been stored and has never crossed the wire, so a
 * reader could not tell a post that was rewritten from one that was not. This
 * pins the flag onto `metadata.isEdited` — and, just as deliberately, pins that
 * NOTHING ELSE about the edit crosses with it.
 *
 * Both truth values are asserted from rows that differ only in that column: a
 * test that only staged `true` would pass just as well against a hard-coded
 * `true`, an unconditional `Boolean(post)`, or a field read off the wrong
 * column, none of which anyone would notice until every post in the app claimed
 * to have been edited.
 *
 * The last case is the one that keeps the feature honest. `editHistory` holds
 * the superseded bodies and is NOT public; hydration reads the flag beside it,
 * so a row carrying both is the fixture that would catch a whole-record spread
 * putting the old text on the DTO.
 */

const POST_ID = '650000000000000000000051';
const AUTHOR_ID = 'oxy-edited-author';

const { getUserById, getUsersByIds, cacheStore } = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getUsersByIds: vi.fn(),
  cacheStore: new Map<string, CachedUserSummary>(),
}));

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

/** Every Postgres read hydration makes, awaiting to `[]` at one seam. */
vi.mock('../../db/postgres', () => {
  const builder = () => {
    const q: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'limit', 'offset', 'groupBy']) {
      q[m] = () => q;
    }
    q.then = (resolve: (value: unknown[]) => unknown) => Promise.resolve([]).then(resolve);
    return q;
  };
  const db = {
    select: () => builder(),
    selectDistinct: () => builder(),
  };
  return { getDb: () => db, connectPostgres: async () => db, closePostgres: async () => {} };
});

vi.mock('../../db/posts/postRepository', () => ({
  loadPostRecords: async () => [],
  findPostRecords: async () => [],
  findBoostedPostIds: async () => new Map(),
  countQuotesOf: async () => new Map(),
  CHRONO_DESC: [],
}));

vi.mock('../../db/federation/actorRepository', () => ({
  findActorsByOxyUserIds: async () => [],
  findActorsByUris: async () => [],
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

/** The body a reader must never be shown — only that it was replaced. */
const SUPERSEDED_TEXT = 'the sentence this post used to say';

/** A published post, optionally carrying the stored edit columns. */
function postRow(edit: { isEdited?: unknown; editHistory?: unknown } = {}) {
  return {
    _id: POST_ID,
    oxyUserId: AUTHOR_ID,
    authorship: [{ oxyUserId: AUTHOR_ID, role: 'owner', status: 'accepted' }],
    type: 'post',
    content: { variants: [{ tag: 'en', source: 'author', text: 'the sentence this post says now' }] },
    stats: { likesCount: 0, boostsCount: 0, commentsCount: 0, downvotesCount: 0, savesCount: 0, viewsCount: 0 },
    metadata: { createdAt: new Date('2026-03-01T00:00:00Z') },
    createdAt: new Date('2026-03-01T00:00:00Z'),
    visibility: 'public',
    hashtags: [],
    mentions: [],
    ...edit,
  };
}

const AUTHOR_ACCOUNT = {
  id: AUTHOR_ID,
  username: 'editor',
  name: { displayName: 'The Editor' },
  kind: 'personal',
  verified: false,
};

let service: PostHydrationService;

beforeEach(() => {
  vi.clearAllMocks();
  cacheStore.clear();
  getUsersByIds.mockResolvedValue([AUTHOR_ACCOUNT]);
  getUserById.mockResolvedValue(AUTHOR_ACCOUNT);
  service = new PostHydrationService();
});

describe('metadata.isEdited', () => {
  it('is true on a post whose body was replaced', async () => {
    const [hydrated] = await service.hydratePosts(
      [postRow({ isEdited: true, editHistory: [SUPERSEDED_TEXT] })],
      { maxDepth: 0 },
    );

    expect(hydrated.metadata.isEdited).toBe(true);
  });

  it('is false on a post whose body was never replaced', async () => {
    // The control for the case above. Same row, same code path, one column
    // flipped — the only fixture that can tell the flag apart from a constant.
    const [hydrated] = await service.hydratePosts(
      [postRow({ isEdited: false, editHistory: [] })],
      { maxDepth: 0 },
    );

    expect(hydrated.metadata.isEdited).toBe(false);
  });

  it('is false, never undefined, when the record carries no such column', async () => {
    // A renderer branches on this directly, so the absent case must land on a
    // boolean rather than leaving the marker in a third state.
    const [hydrated] = await service.hydratePosts([postRow()], { maxDepth: 0 });

    expect(hydrated.metadata.isEdited).toBe(false);
  });

  it('is emitted on a FEED hydration, which does not ask for full metadata', async () => {
    // The flag sits outside the `includeFullMetadata` gate on purpose: the feed
    // is its main consumer, and that gate exists to keep large arrays off feed
    // rows. Gating it there would ship an indicator no feed could draw.
    const [hydrated] = await service.hydratePosts(
      [postRow({ isEdited: true, editHistory: [SUPERSEDED_TEXT] })],
      { maxDepth: 0, includeFullMetadata: false },
    );

    expect(hydrated.metadata.isEdited).toBe(true);
  });

  it('never carries the superseded body onto the DTO', async () => {
    // The flag is the WHOLE disclosure. The edit history is stored but not
    // public, so no part of it — under any key — may reach a client.
    const [hydrated] = await service.hydratePosts(
      [postRow({ isEdited: true, editHistory: [SUPERSEDED_TEXT] })],
      { maxDepth: 0 },
    );

    expect(JSON.stringify(hydrated)).not.toContain(SUPERSEDED_TEXT);
    expect(hydrated).not.toHaveProperty('editHistory');
    expect(hydrated.metadata).not.toHaveProperty('editHistory');
  });
});
