/**
 * What ONE hydration costs the database, measured rather than reasoned about.
 *
 * `db/queryMetrics.ts` times every statement and labels it by primary table, so
 * a hydration's round trips can be counted by table from the metrics registry.
 * That is the only way to state the thing this file is about: hydration is a
 * batched fan-out of a dozen `buildXMap` helpers, and a duplicate read inside it
 * is invisible in the response, invisible in wall clock at forty seeded rows,
 * and invisible to every other test in the suite.
 *
 * Two specific things are pinned.
 *
 * **`user_settings` is read exactly ONCE.** It used to be read twice: the post
 * authors' privacy columns near the top of `buildViewerContext`, and the
 * VIEWER's own four counter flags a few hundred lines below. The second read is
 * gone — nothing consumed its result, and the flags belong to a post's AUTHOR
 * (see `engagementCountPrivacy.ts`), so a viewer-side copy of them could not
 * have been correct if anything had. This assertion is what stops it coming
 * back, because re-adding it breaks no behaviour.
 *
 * **The total, for the coldest case.** Every summary here is a cache MISS (the
 * user-summary cache is a per-test map, cleared immediately before the measured
 * call), which is the shape the efficiency programme measured and the ceiling a
 * warm request stays under. It is a BUDGET, not a law of nature: a genuinely
 * new read on this path should change the number here in the same commit, with
 * the breakdown below saying what it is and why it belongs.
 *
 * The rows are real — a real `posts` row, real `user_settings` rows, a real
 * pool. A mocked repository answers whatever it was told to and would count a
 * query that never happened.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

/**
 * A per-test user-summary cache, so "cold" is a state this file CHOOSES rather
 * than one it inherits from whether the shared Redis mock happens to be ready.
 * The count below is the cold one; clearing it before the measured call is what
 * makes the two starter-pack fills real.
 */
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

import { eq, inArray } from 'drizzle-orm';
import { config } from '../../config';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { userSettings } from '../../db/schema/userProfile';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import { PostHydrationService } from '../../services/PostHydrationService';
import { metrics } from '../../utils/metrics';

const scope = postScope('statement-budget');
const AUTHOR_ID = scope.user('author');
const VIEWER_ID = scope.user('viewer');

/**
 * Statements the instrumentation timed, by primary table.
 *
 * Read out of the Prometheus text rather than a private field: the `_count`
 * series of `db_query_duration_ms` IS the number of statements observed under
 * those labels, and it is the same series production reads.
 */
async function statementsByTable(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const line of (await metrics.getPrometheusFormat()).split('\n')) {
    const match = /^db_query_duration_ms_count\{[^}]*table="([^"]+)"[^}]*\}\s+(\d+)/.exec(line);
    if (match) counts.set(match[1], (counts.get(match[1]) ?? 0) + Number(match[2]));
  }
  return counts;
}

/**
 * Instrumentation is OFF by default under test (a slow-query `warn` must not
 * decide whether a suite is green), and the client is patched ONCE at connect
 * time — so the flag has to be set before `connectPostgres()`, not inside a
 * case. Flipping it afterwards leaves an unpatched pool and a green test
 * measuring nothing.
 */
let previousInstrumentationSetting = false;

beforeAll(async () => {
  previousInstrumentationSetting = config.postgres.queryMetricsEnabled;
  config.postgres.queryMetricsEnabled = true;
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
  config.postgres.queryMetricsEnabled = previousInstrumentationSetting;
});

beforeEach(async () => {
  cacheStore.clear();
  getUsersByIds.mockReset();
  getUsersByIds.mockImplementation(async (ids: string[]) =>
    ids.map((id) => ({ id, username: id, name: { displayName: id }, badges: [], verified: false })),
  );
  await getDb()
    .insert(userSettings)
    .values({ oxyUserId: AUTHOR_ID, privacyProfileVisibility: 'public' })
    .onConflictDoUpdate({
      target: userSettings.oxyUserId,
      set: { privacyProfileVisibility: 'public', privacyHideLikeCounts: false },
    });
});

afterEach(async () => {
  await clearPostScope(scope);
  await getDb().delete(userSettings).where(inArray(userSettings.oxyUserId, [AUTHOR_ID, VIEWER_ID]));
});

function hydrate(posts: object[]) {
  return new PostHydrationService().hydratePosts(posts, {
    viewerId: VIEWER_ID,
    maxDepth: 2,
    oxyClient: {
      getUsersByIds,
      getLinkPreviews: vi.fn(async () => ({})),
      getFileDownloadUrl: (id: string) => `https://cdn.test/${id}`,
    } as never,
  });
}

describe('one hydration reads user_settings once', () => {
  it('reads it ONCE for a viewer who is not the author', async () => {
    const post = await seedPost(scope, { oxyUserId: AUTHOR_ID });

    metrics.reset();
    const result = await hydrate([post]);

    expect(result).toHaveLength(1);
    expect((await statementsByTable()).get('user_settings')).toBe(1);
  });

  it('reads it ONCE when the viewer IS the author', async () => {
    const post = await seedPost(scope, { oxyUserId: VIEWER_ID });

    metrics.reset();
    const result = await hydrate([post]);

    expect(result).toHaveLength(1);
    expect((await statementsByTable()).get('user_settings')).toBe(1);
  });

  it('still hides an author-hidden like count from that ONE read', async () => {
    // The half of the read that survives has to keep working: an author who
    // hides like counts hides them from everyone, and this is where the DTO
    // learns that.
    await getDb()
      .update(userSettings)
      .set({ privacyHideLikeCounts: true })
      .where(eq(userSettings.oxyUserId, AUTHOR_ID));
    const post = await seedPost(scope, { oxyUserId: AUTHOR_ID });

    metrics.reset();
    const [hydrated] = await hydrate([post]);

    expect(hydrated?.engagement?.likes).toBeNull();
    expect((await statementsByTable()).get('user_settings')).toBe(1);
  });

  it('still withholds a private-profile author’s post from that ONE read', async () => {
    // The other half: profile visibility is a separate setting from the post's,
    // and dropping the post is the only thing enforcing it here.
    await getDb()
      .update(userSettings)
      .set({ privacyProfileVisibility: 'private' })
      .where(eq(userSettings.oxyUserId, AUTHOR_ID));
    const post = await seedPost(scope, { oxyUserId: AUTHOR_ID });

    metrics.reset();
    const result = await hydrate([post]);

    expect(result).toHaveLength(0);
    expect((await statementsByTable()).get('user_settings')).toBe(1);
  });
});

describe('the statement budget for one cold hydration', () => {
  it('costs seven round trips for one post, and the same for twenty', async () => {
    /**
     * The budget, and what each entry is. Change a number here only together
     * with the read that moved it.
     *
     *  `user_settings`        1 — author privacy + profile visibility, batched.
     *  `posts`                1 — which of these posts the viewer has boosted.
     *  `likes`                1 — the viewer's like/downvote state.
     *  `bookmarks`            1 — the viewer's saved state.
     *  `post_recent_repliers` 1 — the replier-avatar projection.
     *  `starter_pack_members` 2 — the curation aggregation, once per cache-FILL.
     *                             TWO because a hydration fills twice: the
     *                             viewer (for account languages, which decide
     *                             the localized rendition every post is served)
     *                             before the post graph exists, then the graph's
     *                             authors. Deliberate — see the workstream note
     *                             on why merging them would serialize link
     *                             previews behind the author batch.
     *
     * All five per-viewer reads are `in (...)` over the whole batch, which is
     * why twenty posts cost what one does. A number that grows with the batch
     * is an N+1 and this is where it would show.
     */
    const expected = new Map([
      ['user_settings', 1],
      ['posts', 1],
      ['likes', 1],
      ['bookmarks', 1],
      ['post_recent_repliers', 1],
      ['starter_pack_members', 2],
    ]);

    const one = await seedPost(scope, { oxyUserId: AUTHOR_ID });
    metrics.reset();
    await hydrate([one]);
    expect(await statementsByTable()).toEqual(expected);

    cacheStore.clear();
    const many = await Promise.all(
      Array.from({ length: 20 }, () => seedPost(scope, { oxyUserId: AUTHOR_ID })),
    );
    metrics.reset();
    const hydratedMany = await hydrate(many);

    expect(hydratedMany).toHaveLength(20);
    expect(await statementsByTable()).toEqual(expected);
  });
});
