/**
 * Statement budget: gathering For You candidates must cost NOTHING in
 * child-table statements, however many candidates are gathered — only the
 * final PAGE, after ranking/dedup/slicing trims the pool down, is worth a
 * 9-table join.
 *
 * Two steps, measured separately, because they are two separate claims:
 *
 * 1. **Gathering.** `gatherGlobalLane`/`gatherTrendingLane` (real Postgres,
 *    real seeded posts) must not touch a single child table — they return
 *    `_unassembled` shells (see `assembleShellRecords` in `postRepository.ts`).
 *    Both lanes are exercised because one routes through the `runSource`
 *    helper five other lanes share, and the other inlines the same
 *    `toUnassembledCandidates` call — together, the two code paths every For
 *    You lane uses.
 * 2. **Hydration.** `PostHydrationService.hydrateSlices` resolves whichever
 *    shells survive to the final page in ONE batched `loadPostRecords` call —
 *    so the cost is the SAME whether that page was sliced out of 5 gathered
 *    candidates or 30.
 *
 * Statements are read from `db_query_duration_ms`, the same series production
 * scrapes — not asserted by reasoning about the code.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CachedUserSummary } from '../../services/userSummaryCache';
import type { FeedPostSlice } from '@mention/shared-types';

const { getUsersByIds, cacheStore } = vi.hoisted(() => ({
  getUsersByIds: vi.fn(),
  cacheStore: new Map<string, CachedUserSummary>(),
}));

// Oxy owns identity and is a remote service, so it stays mocked. Everything
// Mention stores is real — same split `postHydrationStatementBudget.test.ts`
// uses for the same reason.
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

import { config } from '../../config';
import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import { gatherGlobalLane, gatherTrendingLane, type GatherForYouCandidatesParams } from '../../mtn/feed/feeds/forYouCandidateSources';
import { PostHydrationService } from '../../services/PostHydrationService';
import { metrics } from '../../utils/metrics';

const scope = postScope('for-you-candidate-gathering-budget');
const VIEWER = scope.user('viewer');

let previousInstrumentationSetting = false;

beforeAll(async () => {
  previousInstrumentationSetting = config.postgres.queryMetricsEnabled;
  // Set BEFORE connecting: the client is patched once, at connect time.
  config.postgres.queryMetricsEnabled = true;
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
  config.postgres.queryMetricsEnabled = previousInstrumentationSetting;
});

beforeEach(() => {
  cacheStore.clear();
  getUsersByIds.mockReset();
  getUsersByIds.mockImplementation(async (ids: string[]) =>
    ids.map((id) => ({ id, username: id, name: { displayName: id }, badges: [], verified: false })),
  );
  metrics.reset();
});

afterEach(async () => {
  await clearPostScope(scope);
});

/** Every table `assemblePostRecords`'s `loadChildRows` reads, one query each. */
const CHILD_TABLES = [
  'post_authorships',
  'post_content_variants',
  'post_media',
  'post_attachments',
  'post_sources',
  'post_mentions',
  'post_classification_topic_refs',
] as const;

async function childTableStatementCounts(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const line of (await metrics.getPrometheusFormat()).split('\n')) {
    const match = /^db_query_duration_ms_count\{[^}]*table="([^"]+)"[^}]*\}\s+(\d+)/.exec(line);
    if (match && (CHILD_TABLES as readonly string[]).includes(match[1])) {
      counts.set(match[1], (counts.get(match[1]) ?? 0) + Number(match[2]));
    }
  }
  return counts;
}

const LANE_PARAMS: GatherForYouCandidatesParams = {
  viewerId: VIEWER,
  followingIds: [],
  seenPostIds: [],
};

function toSlice(posts: object[]): FeedPostSlice[] {
  return [{
    _sliceKey: 'budget-test',
    items: posts.map((post) => ({
      post: post as never,
      isThreadParent: false,
      isThreadChild: false,
      isThreadLastChild: false,
    })),
    isIncompleteThread: false,
  }];
}

describe('For You candidate gathering — statement budget', () => {
  it('gathers shells with zero child-table statements, whatever the pool size', async () => {
    await Promise.all(Array.from({ length: 5 }, () => seedPost(scope)));

    metrics.reset();
    const [global, trending] = await Promise.all([
      gatherGlobalLane(LANE_PARAMS),
      gatherTrendingLane(LANE_PARAMS),
    ]);

    expect(global.length).toBeGreaterThan(0);
    expect(trending.length).toBeGreaterThan(0);
    expect(global.every((post) => post._unassembled === true)).toBe(true);
    expect(trending.every((post) => post._unassembled === true)).toBe(true);

    const counts = await childTableStatementCounts();
    expect(counts.size).toBe(0);
  });

  it('hydrates a small final page for the SAME cost whether it was sliced from a small or a large gathered pool', async () => {
    const PAGE_SIZE = 3;

    await Promise.all(Array.from({ length: 5 }, () => seedPost(scope)));
    const smallPool = await gatherGlobalLane(LANE_PARAMS);
    const smallPage = smallPool.slice(0, PAGE_SIZE);

    metrics.reset();
    await new PostHydrationService().hydrateSlices(toSlice(smallPage), { viewerId: VIEWER });
    const smallPageCounts = await childTableStatementCounts();

    // The page actually got assembled — a (0, 0, ...) map would pass the
    // comparison below vacuously, proving nothing.
    expect(smallPageCounts.get('post_authorships')).toBe(1);

    await clearPostScope(scope);
    cacheStore.clear();

    await Promise.all(Array.from({ length: 30 }, () => seedPost(scope)));
    const largePool = await gatherGlobalLane(LANE_PARAMS);
    const largePage = largePool.slice(0, PAGE_SIZE);

    metrics.reset();
    await new PostHydrationService().hydrateSlices(toSlice(largePage), { viewerId: VIEWER });
    const largePageCounts = await childTableStatementCounts();

    expect(largePageCounts).toEqual(smallPageCounts);
  });
});
