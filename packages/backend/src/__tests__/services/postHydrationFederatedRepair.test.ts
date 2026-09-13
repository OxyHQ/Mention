import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closePostgres, connectPostgres } from '../../db/postgres';
import {
  clearFederationScope,
  federationScope,
  seedActor,
} from '../../__tests__/helpers/federationFixtures';

const scope = federationScope('hydration-fed-repair');

const { getUsersByIds, getUserById, cachedSummaries } = vi.hoisted(() => ({
  cachedSummaries: vi.fn(async (..._args: unknown[]) => new Map()),
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
    getClarityDocuments: vi.fn(async () => ({})),
    getFileDownloadUrl: (id: string) => id,
  }),
}));
vi.mock('../../utils/privacyHelpers', () => ({
  getBlockedUserIds: vi.fn(async () => []),
  getRestrictedUserIds: vi.fn(async () => []),
  extractFollowingIds: vi.fn(() => []),
  extractFollowersIds: vi.fn(() => []),
}));

// Cache misses exercise Oxy outages; the cache-hit case models a previously
// fetched public Oxy DTO. Writes are isolated from other suites.
vi.mock('../../services/userSummaryCache', () => ({
  mget: (...args: unknown[]) => cachedSummaries(...args),
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

describe('resolveUserSummaries Oxy public identity authority', () => {
  beforeEach(async () => {
    await clearFederationScope(scope);
    cachedSummaries.mockResolvedValue(new Map());
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

  it.each([
    ['bridge', 'alice@threads.net', 'alice@ap.brid.gy', 'ap.brid.gy'],
    ['ordinary AP', 'alice@mastodon.social', 'alice@mastodon.social', 'mastodon.social'],
    ['unknown projection', null, 'alice@ap.brid.gy', 'ap.brid.gy'],
  ] as const)('keeps %s unavailable during Oxy outage without publishing transport identity', async (_kind, networkAcct, acct, domain) => {
    await seedActor(scope, {
      username: 'alice', uri: `${scope.origin}/users/alice`,
      acct, domain, networkAcct, oxyUserId: FED_ID,
      avatarUrl: 'https://ap.brid.gy/transport-avatar.png',
    });
    const user = (await resolveUserSummaries([FED_ID])).get(FED_ID)?.user;
    expect(user?.username).toBe('');
    expect(user?.name.displayName).toBe('Unknown user');
    expect(user?.instance).toBeUndefined();
    expect(user?.federation).toBeUndefined();
    expect(user?.avatar).toBeNull();
    expect(JSON.stringify(user)).not.toContain('brid.gy');
  });

  it('retains an Oxy-issued cached public profile without contacting Oxy', async () => {
    cachedSummaries.mockResolvedValue(new Map([[FED_ID, { user: {
      id: FED_ID, username: 'alice@threads.net', name: { displayName: 'Alice' },
      avatar: null, isFederated: true,
    } }]]));
    const user = (await resolveUserSummaries([FED_ID])).get(FED_ID)?.user;
    expect(user?.username).toBe('alice@threads.net');
    expect(user?.name.displayName).toBe('Alice');
    expect(getUsersByIds).not.toHaveBeenCalled();
    expect(getUserById).not.toHaveBeenCalled();
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

  it('stays degraded when both Oxy and the local database are unavailable', async () => {
    // The transport cache cannot supply an alternative public identity.
    await closePostgres();

    const resolved = await resolveUserSummaries([FED_ID]);
    const user = resolved.get(FED_ID)?.user;

    expect(user?.username).toBe('');
    expect(isFallbackUserSummary(user!)).toBe(true);

    await connectPostgres();
  });
});
