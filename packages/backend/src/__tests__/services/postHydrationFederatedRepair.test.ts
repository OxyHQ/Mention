import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PostActorSummary } from '@mention/shared-types';

/**
 * Regression harness for the "federated author renders without its real handle"
 * bug. A federated (e.g. Mastodon) post whose author could not be resolved from
 * Oxy degrades to {@link degradedActorSummary} (empty handle, "Unknown user").
 * For a LOCAL author that neutral placeholder is the best we can do, but a
 * FEDERATED author's canonical `username@domain` is knowable WITHOUT Oxy from
 * Mention's own FederatedActor record — so `repairFederatedFallbackSummaries`
 * upgrades the degraded summary to the real, tappable handle instead of leaving
 * a nameless "Unknown user". This also closes the earlier ghost-handle variant
 * where the fallback used the raw Mongo id as the handle.
 */

const { federatedActorFind } = vi.hoisted(() => ({
  federatedActorFind: vi.fn(),
}));

// PostHydrationService touches these at module load — stub them so importing the
// module never starts the server, hits the network, or opens Redis/Mongo.
vi.mock('../../../server', () => ({
  oxy: {
    getUserById: vi.fn(),
    getUserFollowing: vi.fn(async () => []),
    getUserFollowers: vi.fn(async () => []),
  },
}));
vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUsersByIds: vi.fn(async () => []),
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
vi.mock('../../services/userSummaryCache', () => ({ mget: vi.fn(async () => new Map()), mset: vi.fn(async () => undefined) }));

vi.mock('../../models/FederatedActor', () => ({
  FederatedActor: { find: (...args: unknown[]) => ({ select: () => ({ lean: () => federatedActorFind(...args) }) }) },
  default: { find: (...args: unknown[]) => ({ select: () => ({ lean: () => federatedActorFind(...args) }) }) },
}));

import { repairFederatedFallbackSummaries, degradedActorSummary } from '../../services/PostHydrationService';

const FED_ID = '6a38fbdd272930c46a785b1f';

describe('repairFederatedFallbackSummaries', () => {
  beforeEach(() => {
    federatedActorFind.mockReset();
  });

  it('upgrades a degraded (empty-handle) federated author to the FederatedActor handle', async () => {
    federatedActorFind.mockResolvedValue([
      { oxyUserId: FED_ID, acct: 'kaleidotrope@mastodon.online', username: 'kaleidotrope', domain: 'mastodon.online', name: 'Kaleidotrope' },
    ]);

    const summaries = new Map<string, PostActorSummary>([[FED_ID, degradedActorSummary(FED_ID)]]);
    await repairFederatedFallbackSummaries(summaries, new Set([FED_ID]));

    const repaired = summaries.get(FED_ID);
    expect(repaired?.handle).toBe('kaleidotrope@mastodon.online');
    expect(repaired?.handle).not.toBe('');
    expect(repaired?.handle).not.toBe(FED_ID);
    expect(repaired?.isFederated).toBe(true);
    expect(repaired?.instance).toBe('mastodon.online');
    expect(repaired?.displayName).toBe('Kaleidotrope');
  });

  it('also repairs a legacy raw-id fallback (handle === oxyUserId)', async () => {
    federatedActorFind.mockResolvedValue([
      { oxyUserId: FED_ID, acct: 'kaleidotrope@mastodon.online', domain: 'mastodon.online' },
    ]);

    const summaries = new Map<string, PostActorSummary>([[FED_ID, { id: FED_ID, handle: FED_ID, displayName: FED_ID }]]);
    await repairFederatedFallbackSummaries(summaries, new Set([FED_ID]));

    expect(summaries.get(FED_ID)?.handle).toBe('kaleidotrope@mastodon.online');
  });

  it('derives username@domain when acct is absent, and omits displayName rather than "Unknown user"', async () => {
    federatedActorFind.mockResolvedValue([
      { oxyUserId: FED_ID, username: 'kaleidotrope', domain: 'mastodon.online' },
    ]);

    const summaries = new Map<string, PostActorSummary>([[FED_ID, degradedActorSummary(FED_ID)]]);
    await repairFederatedFallbackSummaries(summaries, new Set([FED_ID]));

    const repaired = summaries.get(FED_ID);
    expect(repaired?.handle).toBe('kaleidotrope@mastodon.online');
    expect(repaired?.displayName).toBeUndefined();
  });

  it('leaves a properly-resolved federated author untouched and never queries', async () => {
    const good: PostActorSummary = {
      id: FED_ID,
      handle: 'kaleidotrope@mastodon.online',
      displayName: 'Kaleidotrope',
      isFederated: true,
      instance: 'mastodon.online',
    };
    const summaries = new Map<string, PostActorSummary>([[FED_ID, { ...good }]]);
    await repairFederatedFallbackSummaries(summaries, new Set([FED_ID]));

    expect(federatedActorFind).not.toHaveBeenCalled();
    expect(summaries.get(FED_ID)).toEqual(good);
  });

  it('is a no-op with no federated authors', async () => {
    const summaries = new Map<string, PostActorSummary>();
    await repairFederatedFallbackSummaries(summaries, new Set());
    expect(federatedActorFind).not.toHaveBeenCalled();
  });

  it('never fails hydration when the FederatedActor lookup throws (stays degraded)', async () => {
    federatedActorFind.mockRejectedValue(new Error('db down'));

    const summaries = new Map<string, PostActorSummary>([[FED_ID, degradedActorSummary(FED_ID)]]);
    await expect(repairFederatedFallbackSummaries(summaries, new Set([FED_ID]))).resolves.toBeUndefined();
    expect(summaries.get(FED_ID)?.handle).toBe('');
  });
});
