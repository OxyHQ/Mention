import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closePostgres, connectPostgres } from '../../db/postgres';
import {
  clearFederationScope,
  federationScope,
  seedActor,
} from '../../__tests__/helpers/federationFixtures';

const scope = federationScope('hydration-fed-repair');

/**
 * Regression harness for the "federated author renders without its real handle"
 * bug. A federated (e.g. Mastodon) post whose author cannot be resolved from Oxy
 * degrades to {@link degradedActorSummary} (empty `username`, "Unknown user").
 * For a LOCAL author that neutral placeholder is the best we can do, but a
 * FEDERATED author's canonical `username@domain` + avatar are knowable WITHOUT
 * Oxy from Mention's own FederatedActor record — so `resolveUserSummaries`
 * enriches the degraded summary in place (restoring `username` / `instance` /
 * `avatar` but NEVER inventing a `name.displayName`) instead of leaving a
 * nameless "Unknown user". This is the canonical-Oxy-User replacement for the old
 * `repairFederatedFallbackSummaries` pass and closes the earlier ghost-handle
 * variant where the fallback used the raw Mongo id as the handle.
 */

const { getUsersByIds, getUserById } = vi.hoisted(() => ({
  getUsersByIds: vi.fn(),
  getUserById: vi.fn(),
}));

// PostHydrationService touches these at module load — stub them so importing the
// module never starts the server, hits the network, or opens Redis/Mongo.
vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({
    getUserById: (...args: unknown[]) => getUserById(...args),
    getUserFollowing: vi.fn(async () => []),
    getUserFollowers: vi.fn(async () => []),
  }),
}));
vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUsersByIds: (...args: unknown[]) => getUsersByIds(...args),
    getLinkPreviews: vi.fn(async () => ({})),
    getFileDownloadUrl: (id: string) => id,
  }),
}));
vi.mock('../../utils/privacyHelpers', () => ({
  getBlockedUserIds: vi.fn(async () => []),
  getRestrictedUserIds: vi.fn(async () => []),
  extractFollowingIds: vi.fn(() => []),
  extractFollowersIds: vi.fn(() => []),
}));

function chainable(rows: unknown[]) {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.lean = async () => rows;
  return q;
}

vi.mock('../../models/Post', () => ({ Post: { find: () => chainable([]), findOne: () => chainable([]) } }));
vi.mock('../../models/Poll', () => ({ default: { find: () => chainable([]) } }));
vi.mock('../../models/Like', () => ({ default: { find: () => chainable([]) } }));
vi.mock('../../models/Bookmark', () => ({ default: { find: () => chainable([]) } }));
// The starter-pack CURATION aggregation runs on the cache-fill path (it stamps the
// ranking-side `starterPackScore`). No DB here → no packs → no scores.
vi.mock('../../models/StarterPack', () => ({
  StarterPack: { aggregate: async () => [] },
  default: { aggregate: async () => [] },
}));
// Cache always misses (so every author flows through the Oxy resolve + enrich
// path), and writes are no-ops.
vi.mock('../../services/userSummaryCache', () => ({
  mget: vi.fn(async () => new Map()),
  mset: vi.fn(async () => undefined),
  invalidate: vi.fn(async () => undefined),
}));

import { resolveUserSummaries, degradedActorSummary, isFallbackUserSummary } from '../../services/PostHydrationService';

/**
 * This file's own federated author. It must not be an id another suite seeds an
 * actor under: the lookup is by `oxy_user_id`, suites share one database and run
 * in parallel, and `postHydrationOrphanBridgy.test.ts` used to seed a different
 * handle on a different instance under this exact literal — so whichever row the
 * query reached first decided the answer, and this file failed intermittently on
 * its handle/instance/avatar assertions while passing in isolation.
 */
const FED_ID = '6a38fbdd272930c46a785b1f';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('resolveUserSummaries federated enrichment', () => {
  beforeEach(async () => {
    await clearFederationScope(scope);
    getUsersByIds.mockReset();
    getUserById.mockReset();
    // Force degradation: Oxy returns nothing from the bulk call and the per-id
    // fallback throws, so the author starts as the degraded placeholder.
    getUsersByIds.mockResolvedValue([]);
    getUserById.mockRejectedValue(new Error('not found'));
  });

  it('degradedActorSummary carries an empty username and neutral name (ghost-handle rule)', () => {
    const degraded = degradedActorSummary(FED_ID);
    expect(degraded.username).toBe('');
    expect(degraded.name.displayName).toBe('Unknown user');
    expect(isFallbackUserSummary(degraded)).toBe(true);
  });

  it('enriches a degraded federated author with its FederatedActor handle + avatar, never a name', async () => {
    await seedActor(scope, {
      username: 'kaleidotrope',
      uri: `${scope.origin}/users/kaleidotrope`,
      acct: `kaleidotrope@${scope.domain}`,
      oxyUserId: FED_ID,
      avatarUrl: `${scope.origin}/a.png`,
    });

    const resolved = await resolveUserSummaries([FED_ID]);
    const user = resolved.get(FED_ID)?.user;

    expect(user?.username).toBe('kaleidotrope');
    expect(user?.username).not.toBe('');
    expect(user?.username).not.toBe(FED_ID);
    expect(user?.isFederated).toBe(true);
    expect(user?.instance).toBe(scope.domain);
    expect(user?.federation?.domain).toBe(scope.domain);
    expect(user?.avatar).toBe(`${scope.origin}/a.png`);
    // Never invent a display name — the FederatedActor has none.
    expect(user?.name.displayName).toBeUndefined();
    expect(isFallbackUserSummary(user!)).toBe(false);
  });

  it('derives the username from acct when the username field is absent', async () => {
    // `username` is written as an empty string, which is what a legacy row that
    // only ever carried an `acct` reads as — the derivation is from `acct`.
    await seedActor(scope, {
      username: '',
      uri: `${scope.origin}/users/kaleidotrope`,
      acct: `kaleidotrope@${scope.domain}`,
      oxyUserId: FED_ID,
    });

    const resolved = await resolveUserSummaries([FED_ID]);
    expect(resolved.get(FED_ID)?.user.username).toBe('kaleidotrope');
  });

  it('leaves a properly-resolved Oxy user untouched and never queries FederatedActor', async () => {
    getUsersByIds.mockResolvedValue([
      { id: FED_ID, username: 'kaleidotrope', name: { displayName: 'Kaleidotrope' }, isFederated: true, instance: 'mastodon.online', avatar: null },
    ]);

    const resolved = await resolveUserSummaries([FED_ID]);
    const user = resolved.get(FED_ID)?.user;

    expect(user?.username).toBe('kaleidotrope');
    expect(user?.name.displayName).toBe('Kaleidotrope');
  });

  it('stays degraded (never throws) when the actor lookup fails', async () => {
    // A closed pool is the real "database unavailable" failure this soft-fails on.
    await closePostgres();

    const resolved = await resolveUserSummaries([FED_ID]);
    const user = resolved.get(FED_ID)?.user;

    expect(user?.username).toBe('');
    expect(isFallbackUserSummary(user!)).toBe(true);

    await connectPostgres();
  });
});
