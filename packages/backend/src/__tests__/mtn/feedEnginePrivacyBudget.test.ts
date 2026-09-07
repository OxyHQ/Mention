/**
 * Oxy call budget: an engine run asks Oxy for the viewer's blocked/restricted
 * lists ZERO times, on every path that hydrates.
 *
 * The privacy counterpart of `feedEngineViewerGraphBudget.test.ts`, and it pins
 * a larger leak than the graph one did. `buildViewerContext` fetched both lists
 * on EVERY hydration call, and a feed page hydrates more than once — measured on
 * an authenticated For You page, `getBlockedUsers` ran three times and
 * `getRestrictedUsers` twice per request, for an answer the controller had
 * already resolved before the engine started. Each one is an HTTP round trip to
 * Oxy sitting on the critical path of a feed page, which is the request a reader
 * waits on while scrolling.
 *
 * `UserPrivacyManager.loadPrivacyState` resolves both lists once per request and
 * the controller puts them on `FeedContext.viewerPrivacy`;
 * `FeedEngine.viewerPrivacyOption` packages them for
 * `HydrationOptions.viewerPrivacy`.
 *
 * ## Why a spy here, and not the metrics registry
 *
 * Same reason the graph budget gives: `oxy_calls_total` is recorded from a patch
 * on `HttpService`'s prototype reached through a real HTTP request, so under a
 * mocked client it records nothing and a budget read from it would pass at zero
 * however many calls the engine made. The spy is sound because hydration reaches
 * these two lists through exactly one object — the `oxyClient` the caller threads
 * in — and this test owns that object.
 *
 * Counts are asserted as equalities against zero rather than
 * `not.toHaveBeenCalled()`, so a failure reports how many calls leaked.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from '../../config';
import { closePostgres, connectPostgres } from '../../db/postgres';
import { metrics } from '../../utils/metrics';
import { clearFederationScope, federationScope, seedPost } from '../helpers/federationFixtures';

const scope = federationScope('feed-engine-privacy-budget');

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
 * A viewer-scoped Oxy client that counts the two PRIVACY reads.
 *
 * The graph pair answers without being counted — it is the other budget's
 * subject, and this context threads it so it would be zero anyway.
 */
function makePrivacyCountingOxyClient() {
  const getBlockedUsers = vi.fn(async () => [] as unknown[]);
  const getRestrictedUsers = vi.fn(async () => [] as unknown[]);
  return {
    client: {
      getBlockedUsers,
      getRestrictedUsers,
      getUserFollowing: async () => ({ data: [] }),
      getUserFollowers: async () => ({ data: [] }),
    } as never,
    /** Privacy round trips this run made against Oxy. */
    privacyCalls: () => getBlockedUsers.mock.calls.length + getRestrictedUsers.mock.calls.length,
  };
}

/** A one-source ranked definition over `candidate`, hydrated by the engine. */
function singleSourceRun(id: string, candidate: CandidatePost): {
  engine: FeedEngine;
  definition: FeedDefinition;
} {
  const registry = new FeedModuleRegistry();
  registry.register({
    id: `${id}-source`,
    kind: 'source',
    userComposable: false,
    gather: async () => [candidate],
  });
  return {
    engine: new FeedEngine(registry),
    definition: {
      id,
      title: id,
      mode: 'ranked',
      sources: [{ module: `${id}-source`, enabled: true }],
      signals: [],
      filters: [],
    },
  };
}

async function seedCandidate(label: string): Promise<CandidatePost> {
  const post = await seedPost(scope, { oxyUserId: scope.user(`${label}-author`) });
  return feedCandidate({ id: post.id, oxyUserId: post.oxyUserId, createdAt: post.createdAt });
}

describe('FeedEngine — viewer-privacy Oxy call budget', () => {
  it('threads the resolved privacy lists on the ranked path', async () => {
    const candidate = await seedCandidate('ranked');
    const { engine, definition } = singleSourceRun('privacy-budget-ranked', candidate);
    const oxy = makePrivacyCountingOxyClient();

    const response = await engine.run(
      definition,
      {
        currentUserId: scope.user('ranked-viewer'),
        followingIds: [],
        followerIds: [],
        viewerPrivacy: { blockedIds: [], restrictedIds: [] },
        viewerLanguages: ['en-US'],
        oxyClient: oxy.client,
      } satisfies FeedEngineContext,
      { limit: 30 },
    );

    // Vacuity guard: a run that hydrated nothing would meet any budget.
    expect(response.items).toHaveLength(1);
    expect(oxy.privacyCalls()).toBe(0);
  });

  it('threads them on the never-blank popular fallback too', async () => {
    // The path an authenticated reader reaches when For You exhausts their unseen
    // pool — ordinary deep scroll, and the one the graph budget found unthreaded.
    const candidate = await seedCandidate('fallback');

    const registry = new FeedModuleRegistry();
    registry.register({
      id: 'privacy-budget-fallback-ranked',
      kind: 'source',
      userComposable: false,
      gather: async () => [],
    });
    registry.register({
      id: 'privacy-budget-fallback-popular',
      kind: 'source',
      userComposable: false,
      gather: async () => [candidate],
    });

    const oxy = makePrivacyCountingOxyClient();
    const response = await new FeedEngine(registry).run(
      {
        id: 'privacy-budget-fallback',
        title: 'Privacy budget, fallback',
        mode: 'ranked',
        sources: [{ module: 'privacy-budget-fallback-ranked', enabled: true }],
        signals: [],
        filters: [],
        execution: {
          popularFallback: 'privacy-budget-fallback-popular',
          neverBlank: true,
          hydrateMaxDepth: 0,
        },
      } satisfies FeedDefinition,
      {
        currentUserId: scope.user('fallback-viewer'),
        followingIds: [],
        followerIds: [],
        viewerPrivacy: { blockedIds: [], restrictedIds: [] },
        viewerLanguages: ['en-US'],
        oxyClient: oxy.client,
      } satisfies FeedEngineContext,
      { limit: 30 },
    );

    // The fallback puts its posts in `items` and leaves `slices` empty, so this
    // also proves the run took the fallback rather than an empty ranked page.
    expect(response.items).toHaveLength(1);
    expect(response.slices).toHaveLength(0);
    expect(oxy.privacyCalls()).toBe(0);
  });

  it('still falls back to the live, fail-closed fetch when nothing was threaded', async () => {
    /**
     * The negative control, and the reason threading is opt-in.
     *
     * Every non-feed caller (post detail, notifications, profile, search) resolves
     * no privacy state up front, so hydration must keep its own live fetch — which
     * THROWS when Oxy cannot answer rather than treating an outage as "this viewer
     * blocks nobody". Without this, the budget above would keep passing if
     * hydration simply stopped reading the lists at all, which is the same number
     * for the opposite reason.
     */
    const candidate = await seedCandidate('unthreaded');
    const { engine, definition } = singleSourceRun('privacy-budget-unthreaded', candidate);
    const oxy = makePrivacyCountingOxyClient();

    const response = await engine.run(
      definition,
      {
        currentUserId: scope.user('unthreaded-viewer'),
        followingIds: [],
        followerIds: [],
        // `viewerPrivacy` deliberately absent — every non-feed caller's shape.
        viewerLanguages: ['en-US'],
        oxyClient: oxy.client,
      } satisfies FeedEngineContext,
      { limit: 30 },
    );

    expect(response.items).toHaveLength(1);
    expect(oxy.privacyCalls()).toBeGreaterThan(0);
  });
});
