/**
 * Statement budget: the viewer's accepted OUTBOUND federated follows are read
 * ONCE per authenticated For You request.
 *
 * Two consumers need that exact set on the same request — the feed context
 * merges it into `followingIds`, and the mutual-id intersection (which For You
 * resolves whenever the `socialProof` signal is active) needs it to intersect
 * against the inbound side. They used to issue it separately, so
 * `federated_follows` was read THREE times per request and two of the three were
 * byte-identical.
 *
 * The budget is TWO: one outbound read, shared, plus the genuinely different
 * inbound read. It is measured from `db_query_duration_ms`, the same series
 * production scrapes, rather than from a spy on the repository — a spy would
 * keep passing if the duplication moved somewhere else in the path.
 *
 * The two assertions AFTER the budget are what stop it from passing vacuously.
 * If `socialProof` were switched off, or the intersection stopped running, the
 * outbound read would legitimately happen once and the budget would be met
 * while measuring nothing. `mutualIds` carrying the seeded federated mutual is
 * proof the intersection ran; `followingIds` carrying it is proof the merge ran.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from '../../config';
import { closePostgres, connectPostgres } from '../../db/postgres';
import { metrics } from '../../utils/metrics';
import {
  clearFederationScope,
  federationScope,
  seedActor,
  seedFollow,
} from '../helpers/federationFixtures';

const scope = federationScope('for-you-follow-graph-budget');

/**
 * The engine is stubbed so the statements counted are exactly the context load's
 * — the budget is about how the viewer's graph is assembled, and a real engine
 * run would fold in every candidate source's own reads.
 */
let capturedContext: Record<string, unknown> | undefined;
vi.mock('../../mtn/feed/engine/FeedEngine', () => ({
  feedEngine: {
    run: vi.fn(async (_definition: unknown, ctx: Record<string, unknown>) => {
      capturedContext = ctx;
      return { slices: [], items: [], hasMore: false, totalCount: 0 };
    }),
    peekLatest: vi.fn(async () => undefined),
  },
}));

const oxyGraphClient = {
  getBlockedUsers: vi.fn(async () => []),
  getRestrictedUsers: vi.fn(async () => []),
  getUserFollowing: vi.fn(async () => ({ data: [] })),
  getUserFollowers: vi.fn(async () => ({ data: [] })),
  getMutualUserIds: vi.fn(async () => ['oxymutual']),
};

vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => oxyGraphClient,
}));

vi.mock('../../utils/oxyHelpers', () => ({
  // The viewer must RESOLVE, or `resolveUserSummaries` falls into its federated
  // repair path and adds reads that have nothing to do with this budget.
  getServiceOxyClient: () => ({
    getUsersByIds: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, username: `u${id.slice(-6)}`, name: {}, languages: ['en-US'] })),
    ),
    getLinkPreviews: vi.fn(async () => []),
  }),
  createScopedOxyClient: () => oxyGraphClient,
}));

import { forYouUsesSocialProof } from '../../mtn/feed/definitions/presets';
import { mtnFeedController } from '../../mtn/controllers/feed.controller';

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

const VIEWER = scope.localUserId;
const MUTUAL_ACTOR = `${scope.origin}/users/mutual`;

beforeEach(async () => {
  await clearFederationScope(scope);
  // A MUTUAL federated edge: the viewer follows the actor and is followed back.
  await seedActor(scope, { username: 'mutual', uri: MUTUAL_ACTOR, oxyUserId: 'fedmutual' });
  await seedFollow(scope, { remoteActorUri: MUTUAL_ACTOR, direction: 'outbound', status: 'accepted' });
  await seedFollow(scope, { remoteActorUri: MUTUAL_ACTOR, direction: 'inbound', status: 'accepted' });
  capturedContext = undefined;
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

function makeRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
}

describe('For You feed — federated follow-graph statement budget', () => {
  it('reads federated_follows twice: one shared outbound, one inbound', async () => {
    // The duplication only existed because For You resolves mutuals at all.
    expect(forYouUsesSocialProof()).toBe(true);

    const req = { query: { descriptor: 'for_you' }, user: { id: VIEWER } } as never;
    const res = makeRes();
    await mtnFeedController.getFeed(req, res as never);

    expect((res.body as { success: boolean }).success).toBe(true);
    expect(await statementsAgainst('federated_follows')).toBe(2);

    // Neither consumer was skipped — see the docblock.
    expect(capturedContext?.mutualIds).toEqual(expect.arrayContaining(['fedmutual']));
    expect(capturedContext?.followingIds).toEqual(expect.arrayContaining(['fedmutual']));
  });
});
