import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CachedUserSummary } from '../../services/userSummaryCache';

/**
 * THE CORRECTION MARKER ON A POST DTO.
 *
 * A channel post stays editable for life, and `metadata.corrections` is what
 * tells a reader it changed. Everything here pins ONE property: the marker is
 * emitted when — and only when — the post can actually answer both questions a
 * reader has ("did this change?" and "when?").
 *
 * Both halves are required rather than defaulted, and the fixtures below are the
 * reason that is testable: a count with no timestamp and a timestamp with no
 * count are each staged on their own, so a change that filled a missing half
 * with `Date.now()` or `0` would go red instead of shipping a marker that states
 * something nobody recorded.
 *
 * The unparseable-timestamp case is not decoration. The column is nullable and
 * hydration reaches it through `RawPost`, whose fields are `unknown`, so a bad
 * value is REACHABLE — and `toISOString()` throws on one, which would fail the
 * hydration of the whole PAGE rather than of this field. That is the same guard
 * `scheduledFor` carries one line above it.
 */

const POST_ID = '650000000000000000000041';
const AUTHOR_ID = 'oxy-corrections-author';

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

/** A published post, optionally carrying a correction summary. */
function postRow(summary: { correctionCount?: unknown; lastCorrectedAt?: unknown } = {}) {
  return {
    _id: POST_ID,
    oxyUserId: AUTHOR_ID,
    authorship: [{ oxyUserId: AUTHOR_ID, role: 'owner', status: 'accepted' }],
    type: 'post',
    content: { variants: [{ tag: 'en', source: 'author', text: 'a corrected note' }] },
    stats: { likesCount: 0, boostsCount: 0, commentsCount: 0, downvotesCount: 0, savesCount: 0, viewsCount: 0 },
    metadata: { createdAt: new Date('2026-02-01T00:00:00Z') },
    createdAt: new Date('2026-02-01T00:00:00Z'),
    visibility: 'public',
    hashtags: [],
    mentions: [],
    ...summary,
  };
}

const AUTHOR_ACCOUNT = {
  id: AUTHOR_ID,
  username: 'thechannel',
  name: { displayName: 'The Channel' },
  kind: 'channel',
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

describe('metadata.corrections', () => {
  it('is emitted with the count and the time of the last correction', async () => {
    const [hydrated] = await service.hydratePosts(
      [postRow({ correctionCount: 3, lastCorrectedAt: new Date('2026-02-02T10:00:00Z') })],
      { maxDepth: 0 },
    );

    expect(hydrated.metadata.corrections).toEqual({
      count: 3,
      lastCorrectedAt: '2026-02-02T10:00:00.000Z',
    });
  });

  it('is ABSENT on a post that was never corrected', async () => {
    // Absent, not a zeroed object: a renderer's presence check is meant to be
    // the whole condition for showing the marker.
    const [hydrated] = await service.hydratePosts(
      [postRow({ correctionCount: 0, lastCorrectedAt: null })],
      { maxDepth: 0 },
    );

    expect(hydrated.metadata.corrections).toBeUndefined();
  });

  it('is ABSENT on a post that predates the column entirely', async () => {
    const [hydrated] = await service.hydratePosts([postRow()], { maxDepth: 0 });

    expect(hydrated.metadata.corrections).toBeUndefined();
  });

  it('is ABSENT when there is a count but no time', async () => {
    // The half-recorded shape. Emitting here would state a correction happened
    // and be unable to say when, which is the one thing the summary exists for.
    const [hydrated] = await service.hydratePosts(
      [postRow({ correctionCount: 2, lastCorrectedAt: null })],
      { maxDepth: 0 },
    );

    expect(hydrated.metadata.corrections).toBeUndefined();
  });

  it('is ABSENT when there is a time but no count', async () => {
    const [hydrated] = await service.hydratePosts(
      [postRow({ correctionCount: 0, lastCorrectedAt: new Date('2026-02-02T10:00:00Z') })],
      { maxDepth: 0 },
    );

    expect(hydrated.metadata.corrections).toBeUndefined();
  });

  it('survives an unparseable correction time instead of failing the page', async () => {
    // A throw here would take the whole hydration down, not just this field —
    // so the post must still hydrate, simply without a marker it cannot date.
    const [hydrated] = await service.hydratePosts(
      [postRow({ correctionCount: 2, lastCorrectedAt: 'not a date' })],
      { maxDepth: 0 },
    );

    expect(hydrated).toBeDefined();
    expect(hydrated.metadata.corrections).toBeUndefined();
  });

  it('refuses a non-numeric count', async () => {
    // The fixture that tells `typeof === 'number'` from a truthiness check: a
    // non-empty string is truthy and would emit `count: "3"` onto the DTO.
    const [hydrated] = await service.hydratePosts(
      [postRow({ correctionCount: '3', lastCorrectedAt: new Date('2026-02-02T10:00:00Z') })],
      { maxDepth: 0 },
    );

    expect(hydrated.metadata.corrections).toBeUndefined();
  });
});
