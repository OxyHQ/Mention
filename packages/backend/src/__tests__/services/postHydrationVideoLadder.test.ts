import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CachedUserSummary } from '../../services/userSummaryCache';

/**
 * A stored video's HLS ladder stamp reaches the post DTO as `hlsUrl`.
 *
 * Production, 2026-10-10: a backfill stamped `post_media.hls_ready_at` on
 * 26,228 videos and the post API still served none of them an `hlsUrl`.
 * Hydration reads each stored media item through `readPersistedMediaFields`,
 * and the stamp was not on that list, so it was dropped between the row and
 * the resolver. Every player was then handed the uploaded original, which an
 * iPhone cannot decode when it is VP9.
 *
 * The control flips only the stamp. Without it, an `hlsUrl` built from the id
 * alone would pass the first case too.
 */

const POST_ID = '650000000000000000000071';
const AUTHOR_ID = 'oxy-ladder-author';
const FILE_ID = '01a12355-5f04-73a5-bb5b-dbf6f53ce659';

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

/** Every Postgres read hydration makes, awaiting to `[]` at one seam. */
vi.mock('../../db/postgres', () => {
  const builder = () => {
    const q: Record<string, unknown> = {};
    for (const m of [
      'from',
      'where',
      'innerJoin',
      'leftJoin',
      'orderBy',
      'limit',
      'offset',
      'groupBy',
    ]) {
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

function postRow(video: Record<string, unknown>) {
  return {
    _id: POST_ID,
    oxyUserId: AUTHOR_ID,
    authorship: [{ oxyUserId: AUTHOR_ID, role: 'owner', status: 'accepted' }],
    type: 'video',
    content: {
      variants: [{ tag: 'en', source: 'author', text: 'my reel' }],
      media: [
        { id: FILE_ID, type: 'video', width: 1916, height: 1078, durationSec: 181, ...video },
      ],
    },
    stats: {
      likesCount: 0,
      boostsCount: 0,
      commentsCount: 0,
      downvotesCount: 0,
      savesCount: 0,
      viewsCount: 0,
    },
    metadata: { createdAt: new Date('2026-10-10T00:00:00Z') },
    createdAt: new Date('2026-10-10T00:00:00Z'),
    visibility: 'public',
    hashtags: [],
    mentions: [],
  };
}

const AUTHOR_ACCOUNT = {
  id: AUTHOR_ID,
  username: 'reeler',
  name: { displayName: 'The Reeler' },
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

function hydratedVideo(post: { content?: { media?: Array<Record<string, unknown>> } }) {
  return post.content?.media?.[0] ?? {};
}

describe('the HLS ladder on a hydrated post', () => {
  it('is advertised as hlsUrl once Oxy has stamped it', async () => {
    const [hydrated] = await service.hydratePosts(
      [postRow({ hlsReadyAt: '2026-10-10T01:42:43.597Z' })],
      { maxDepth: 0 },
    );

    const video = hydratedVideo(hydrated as never);
    expect(video.hlsUrl).toEqual(expect.stringContaining(`${FILE_ID}?variant=hls_master`));
    // The original stays the fallback.
    expect(video.url).toEqual(expect.stringContaining(FILE_ID));
  });

  it('is not advertised for a video whose ladder is not stamped', async () => {
    const [hydrated] = await service.hydratePosts([postRow({})], { maxDepth: 0 });

    expect(hydratedVideo(hydrated as never).hlsUrl).toBeUndefined();
  });
});
