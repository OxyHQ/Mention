/**
 * Oxy call budget: an engine run asks Oxy for the viewer's social graph ZERO
 * times, on every path that hydrates — the never-blank popular fallback included.
 *
 * `loadViewerFeedContext` already resolves the viewer's following/follower ids
 * once per request and puts them on the context; `HydrationOptions.viewerGraph`
 * exists so hydration can be handed that answer instead of re-fetching it.
 * `FeedEngine.viewerGraphOption` packages it, and four of the engine's five
 * hydration sites passed it.
 *
 * The fifth — `runPopularFallback` — did not. That is the path an authenticated
 * reader reaches when For You exhausts their unseen pool, i.e. ordinary deep
 * scroll rather than an edge case, and it paid `getUserFollowing` +
 * `getUserFollowers` against Oxy on every page while the answer sat on `ctx`.
 * Nothing went red when it landed, because nothing in this repository pinned an
 * Oxy call count at all: `postHydrationStatementBudget.test.ts` pins Postgres
 * statements, and the efficiency programme's own measurement note says the
 * expensive stage on this path is plausibly network, not Postgres.
 *
 * ## Why a spy here, and not the metrics registry
 *
 * The sibling budgets read `db_query_duration_ms` out of the Prometheus text
 * because a spy on a repository would keep passing if the duplication moved
 * elsewhere in the path. The equivalent series exists for Oxy (`oxy_calls_total`,
 * `utils/oxyMetrics.ts`) but it is recorded from a patch on `HttpService`'s
 * PROTOTYPE, reached through a real `OxyServices` making a real HTTP request —
 * so under a mocked client it records nothing, and a budget read from it would
 * pass at zero no matter what the engine did.
 *
 * The spy is sound here for a reason that does not hold for the repository case:
 * `buildViewerContext` reaches Oxy for the graph through exactly one object, the
 * `oxyClient` the caller threads in, and this test owns that object. There is no
 * second route to the same data for the assertion to miss.
 *
 * The counts are asserted as an EQUALITY against zero rather than
 * `not.toHaveBeenCalled()`, so a failure reports how many calls leaked.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from '../../config';
import { closePostgres, connectPostgres } from '../../db/postgres';
import { metrics } from '../../utils/metrics';
import { clearFederationScope, federationScope, seedPost } from '../helpers/federationFixtures';

const scope = federationScope('feed-engine-viewer-graph-budget');

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUsersByIds: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, username: `u${id.slice(-6)}`, name: {}, languages: ['en-US'] })),
    ),
    getLinkPreviews: vi.fn(async () => []),
  }),
  createScopedOxyClient: () => undefined,
}));

import { FeedEngine } from '../../mtn/feed/engine/FeedEngine';
import { FeedModuleRegistry } from '../../mtn/feed/engine/FeedModuleRegistry';
import type { CandidatePost, FeedDefinition, FeedEngineContext } from '../../mtn/feed/engine/types';
import { feedCandidate } from '../fixtures/feedCandidate';

/** Restored on teardown: the flag is process-global and workers are reused. */
let previousInstrumentationSetting = false;

beforeAll(async () => {
  previousInstrumentationSetting = config.postgres.queryMetricsEnabled;
  config.postgres.queryMetricsEnabled = true;
  await connectPostgres();
});

afterAll(async () => {
  await clearFederationScope(scope);
  await closePostgres();
  config.postgres.queryMetricsEnabled = previousInstrumentationSetting;
});

beforeEach(() => {
  metrics.reset();
});

/**
 * A viewer-scoped Oxy client that counts the two graph reads.
 *
 * `getUserFollowing`/`getUserFollowers` are the pair `buildViewerContext` issues
 * when no `viewerGraph` is threaded; the blocked/restricted reads are a separate
 * concern (they are not on the context and are not what this budget is about),
 * so they answer without being counted.
 */
function makeGraphCountingOxyClient() {
  const getUserFollowing = vi.fn(async () => ({ data: [] }));
  const getUserFollowers = vi.fn(async () => ({ data: [] }));
  return {
    getUserFollowing,
    getUserFollowers,
    client: {
      getBlockedUsers: async () => [],
      getRestrictedUsers: async () => [],
      getUserFollowing,
      getUserFollowers,
    } as never,
    /** Graph round trips this run made against Oxy. */
    graphCalls: () => getUserFollowing.mock.calls.length + getUserFollowers.mock.calls.length,
  };
}

describe('FeedEngine — viewer-graph Oxy call budget', () => {
  it('threads the resolved graph on the authenticated never-blank fallback', async () => {
    const viewerId = scope.user('fallback-viewer');
    const post = await seedPost(scope, { oxyUserId: scope.user('fallback-author') });
    const candidate: CandidatePost = feedCandidate({
      id: post.id,
      oxyUserId: post.oxyUserId,
      createdAt: post.createdAt,
    });

    // The ranked source is EMPTY and the fallback source is not: that pair is
    // what `deduped.length === 0 && neverBlank && popularFallback &&
    // currentUserId` requires, and it is the only way into `runPopularFallback`.
    const registry = new FeedModuleRegistry();
    registry.register({
      id: 'viewer-graph-budget-ranked',
      kind: 'source',
      userComposable: false,
      gather: async () => [],
    });
    registry.register({
      id: 'viewer-graph-budget-popular',
      kind: 'source',
      userComposable: false,
      gather: async () => [candidate],
    });

    const engine = new FeedEngine(registry);
    const definition: FeedDefinition = {
      id: 'viewer-graph-budget',
      title: 'Viewer graph budget',
      mode: 'ranked',
      sources: [{ module: 'viewer-graph-budget-ranked', enabled: true }],
      signals: [],
      filters: [],
      execution: {
        popularFallback: 'viewer-graph-budget-popular',
        neverBlank: true,
        hydrateMaxDepth: 0,
      },
    };

    const oxy = makeGraphCountingOxyClient();
    const context: FeedEngineContext = {
      currentUserId: viewerId,
      // Both lists present, which is what `viewerGraphOption` requires before it
      // will thread anything. `loadViewerFeedContext` always sets them.
      followingIds: [],
      followerIds: [],
      viewerLanguages: ['en-US'],
      oxyClient: oxy.client,
    };

    const response = await engine.run(definition, context, { limit: 30 });

    // Vacuity guard: this must be the FALLBACK page, not an empty ranked one.
    // The fallback puts its posts in `items` and leaves `slices` empty — see the
    // note on `runPopularFallback`. A run that hydrated nothing would meet any
    // budget, and a run that took the ranked path would never reach the code
    // this test exists to pin.
    expect(response.items).toHaveLength(1);
    expect(response.slices).toHaveLength(0);

    expect(oxy.graphCalls()).toBe(0);
  });

  it('threads it on the ranked path too, so the fallback is not a special case', async () => {
    // The control that says the assertion above is about `runPopularFallback`
    // specifically rather than about hydration never asking Oxy for anything.
    // Same client, same budget, the path that was always correct.
    const viewerId = scope.user('ranked-viewer');
    const post = await seedPost(scope, { oxyUserId: scope.user('ranked-author') });
    const candidate: CandidatePost = feedCandidate({
      id: post.id,
      oxyUserId: post.oxyUserId,
      createdAt: post.createdAt,
    });

    const registry = new FeedModuleRegistry();
    registry.register({
      id: 'viewer-graph-budget-ranked-only',
      kind: 'source',
      userComposable: false,
      gather: async () => [candidate],
    });

    const engine = new FeedEngine(registry);
    const definition: FeedDefinition = {
      id: 'viewer-graph-budget-ranked-only',
      title: 'Viewer graph budget, ranked',
      mode: 'ranked',
      sources: [{ module: 'viewer-graph-budget-ranked-only', enabled: true }],
      signals: [],
      filters: [],
    };

    const oxy = makeGraphCountingOxyClient();
    const response = await engine.run(
      definition,
      {
        currentUserId: viewerId,
        followingIds: [],
        followerIds: [],
        viewerLanguages: ['en-US'],
        oxyClient: oxy.client,
      } satisfies FeedEngineContext,
      { limit: 30 },
    );

    expect(response.items).toHaveLength(1);
    expect(oxy.graphCalls()).toBe(0);
  });

  it('still falls back to the live fetch when the context graph is PARTIAL', async () => {
    /**
     * The negative control, and the reason `viewerGraphOption` returns
     * `undefined` rather than a half-built graph.
     *
     * The peek path builds a context with `followingIds` but no `followerIds`.
     * Threading that would hydrate every post against an EMPTY follower set —
     * silently wrong "followed by" state rather than a slow request. So a partial
     * context must still pay the live fetch, and this asserts the budget above is
     * bought by the context being complete, not by hydration having quietly
     * stopped reading the graph at all.
     */
    const viewerId = scope.user('partial-viewer');
    const post = await seedPost(scope, { oxyUserId: scope.user('partial-author') });
    const candidate: CandidatePost = feedCandidate({
      id: post.id,
      oxyUserId: post.oxyUserId,
      createdAt: post.createdAt,
    });

    const registry = new FeedModuleRegistry();
    registry.register({
      id: 'viewer-graph-budget-partial',
      kind: 'source',
      userComposable: false,
      gather: async () => [candidate],
    });

    const engine = new FeedEngine(registry);
    const oxy = makeGraphCountingOxyClient();
    const response = await engine.run(
      {
        id: 'viewer-graph-budget-partial',
        title: 'Viewer graph budget, partial context',
        mode: 'ranked',
        sources: [{ module: 'viewer-graph-budget-partial', enabled: true }],
        signals: [],
        filters: [],
      } satisfies FeedDefinition,
      {
        currentUserId: viewerId,
        followingIds: [],
        // `followerIds` deliberately absent — the peek path's shape.
        viewerLanguages: ['en-US'],
        oxyClient: oxy.client,
      } as FeedEngineContext,
      { limit: 30 },
    );

    expect(response.items).toHaveLength(1);
    expect(oxy.graphCalls()).toBeGreaterThan(0);
  });
});
