import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const { federatedActorFind, getUsersByIds, getUserById } = vi.hoisted(() => ({
  federatedActorFind: vi.fn(),
  getUsersByIds: vi.fn(),
  getUserById: vi.fn(),
}));

// PostHydrationService touches these at module load — stub them so importing the
// module never starts the server, hits the network, or opens Redis/Mongo.
vi.mock('../../../server', () => ({
  oxy: {
    getUserById: (...args: unknown[]) => getUserById(...args),
    getUserFollowing: vi.fn(async () => []),
    getUserFollowers: vi.fn(async () => []),
  },
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
vi.mock('../../models/UserSettings', () => ({ UserSettings: { find: () => chainable([]), findOne: () => chainable([]) } }));
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

vi.mock('../../models/FederatedActor', () => ({
  FederatedActor: { find: (...args: unknown[]) => ({ select: () => ({ lean: () => federatedActorFind(...args) }) }) },
  default: { find: (...args: unknown[]) => ({ select: () => ({ lean: () => federatedActorFind(...args) }) }) },
}));

import { resolveUserSummaries, degradedActorSummary, isFallbackUserSummary } from '../../services/PostHydrationService';

const FED_ID = '6a38fbdd272930c46a785b1f';

describe('resolveUserSummaries federated enrichment', () => {
  beforeEach(() => {
    federatedActorFind.mockReset();
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
    federatedActorFind.mockResolvedValue([
      { oxyUserId: FED_ID, acct: 'kaleidotrope@mastodon.online', username: 'kaleidotrope', domain: 'mastodon.online', avatarUrl: 'https://mastodon.online/a.png' },
    ]);

    const resolved = await resolveUserSummaries([FED_ID]);
    const user = resolved.get(FED_ID)?.user;

    expect(user?.username).toBe('kaleidotrope');
    expect(user?.username).not.toBe('');
    expect(user?.username).not.toBe(FED_ID);
    expect(user?.isFederated).toBe(true);
    expect(user?.instance).toBe('mastodon.online');
    expect(user?.federation?.domain).toBe('mastodon.online');
    expect(user?.avatar).toBe('https://mastodon.online/a.png');
    // Never invent a display name — the FederatedActor has none.
    expect(user?.name.displayName).toBeUndefined();
    expect(isFallbackUserSummary(user!)).toBe(false);
  });

  it('derives the username from acct when the username field is absent', async () => {
    federatedActorFind.mockResolvedValue([
      { oxyUserId: FED_ID, acct: 'kaleidotrope@mastodon.online', domain: 'mastodon.online' },
    ]);

    const resolved = await resolveUserSummaries([FED_ID]);
    expect(resolved.get(FED_ID)?.user.username).toBe('kaleidotrope');
  });

  it('leaves a properly-resolved Oxy user untouched and never queries FederatedActor', async () => {
    getUsersByIds.mockResolvedValue([
      { id: FED_ID, username: 'kaleidotrope', name: { displayName: 'Kaleidotrope' }, isFederated: true, instance: 'mastodon.online', avatar: null },
    ]);

    const resolved = await resolveUserSummaries([FED_ID]);
    const user = resolved.get(FED_ID)?.user;

    expect(federatedActorFind).not.toHaveBeenCalled();
    expect(user?.username).toBe('kaleidotrope');
    expect(user?.name.displayName).toBe('Kaleidotrope');
  });

  it('stays degraded (never throws) when the FederatedActor lookup fails', async () => {
    federatedActorFind.mockRejectedValue(new Error('db down'));

    const resolved = await resolveUserSummaries([FED_ID]);
    const user = resolved.get(FED_ID)?.user;

    expect(user?.username).toBe('');
    expect(isFallbackUserSummary(user!)).toBe(true);
  });
});
