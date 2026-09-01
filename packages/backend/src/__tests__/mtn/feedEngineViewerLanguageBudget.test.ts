/**
 * Statement budget: an engine run resolves the viewer's identity ONCE.
 *
 * `HydrationOptions.viewerLanguages` exists so a caller that already resolved
 * the viewer's Oxy account locales can hand them over instead of making
 * hydration resolve the viewer a second time. The feed resolves them — that is
 * what `loadViewerFeedContext` puts on `ctx.viewerLanguages` for the ranking
 * signal — and `FeedEngine` was dropping them on the floor at every hydration
 * call, so hydration re-resolved the viewer on every feed request.
 *
 * The observable cost is `resolveUserSummaries`' starter-pack CTE, which runs
 * once per distinct id cohort it has to fetch. The budget is TWO: one cohort for
 * the page's AUTHORS (ranking's authority signal and hydration's author map
 * share it), and — because this test supplies `viewerLanguages` — none for the
 * viewer. Without the threading it is three.
 *
 * Measured from `db_query_duration_ms`, the series production scrapes, against
 * real Postgres and the real `PostHydrationService`. Redis is unavailable under
 * test (see `__tests__/setup.ts`), which is exactly the cold-cache case where
 * the duplicate resolution costs a database round trip rather than a cache hit.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from '../../config';
import { closePostgres, connectPostgres } from '../../db/postgres';
import { metrics } from '../../utils/metrics';
import { clearFederationScope, federationScope, seedPost } from '../helpers/federationFixtures';

const scope = federationScope('feed-engine-viewer-language-budget');

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUsersByIds: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, username: `u${id.slice(-6)}`, name: {}, languages: ['es-ES'] })),
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
  // Set BEFORE connecting: the client is patched once, at connect time.
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

/** How many statements the registry recorded against one table. */
async function statementsAgainst(table: string): Promise<number> {
  const exposition = await metrics.getPrometheusFormat();
  const pattern = new RegExp(
    `^db_query_duration_ms_count\\{operation="[a-z]+",table="${table}"\\} (\\d+)$`,
    'gm',
  );
  let total = 0;
  let match = pattern.exec(exposition);
  while (match) {
    total += Number(match[1]);
    match = pattern.exec(exposition);
  }
  return total;
}

const VIEWER_LANGUAGES = ['es-ES'];

describe('FeedEngine — viewer-language hydration budget', () => {
  it('does not re-resolve the viewer when the context already carries their languages', async () => {
    const viewerId = scope.user('viewer');
    const post = await seedPost(scope, { oxyUserId: scope.user('author') });
    const candidate: CandidatePost = feedCandidate({
      id: post.id,
      oxyUserId: post.oxyUserId,
      createdAt: post.createdAt,
    });

    const registry = new FeedModuleRegistry();
    registry.register({
      id: 'viewer-language-budget-source',
      kind: 'source',
      userComposable: false,
      gather: async () => [candidate],
    });
    const engine = new FeedEngine(registry);
    const definition: FeedDefinition = {
      id: 'viewer-language-budget',
      title: 'Viewer language budget',
      mode: 'ranked',
      sources: [{ module: 'viewer-language-budget-source', enabled: true }],
      signals: [],
      filters: [],
    };
    const context: FeedEngineContext = {
      currentUserId: viewerId,
      followingIds: [],
      followerIds: [],
      viewerLanguages: VIEWER_LANGUAGES,
      oxyClient: {
        getBlockedUsers: async () => [],
        getRestrictedUsers: async () => [],
        getUserFollowing: async () => ({ data: [] }),
        getUserFollowers: async () => ({ data: [] }),
      } as never,
    };

    metrics.reset();
    const response = await engine.run(definition, context, { limit: 30 });

    // Vacuity guard: a run that hydrated nothing would meet any budget.
    expect(response.items).toHaveLength(1);
    expect(await statementsAgainst('starter_pack_members')).toBe(2);
  });
});
