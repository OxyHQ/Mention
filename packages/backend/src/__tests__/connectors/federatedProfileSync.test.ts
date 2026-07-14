import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Sync-on-view for federated profiles.
 *
 * The contract the feed layer depends on:
 *  - viewing a FEDERATED author's empty profile kicks off an outbox sync and
 *    reports `pending` so the client polls;
 *  - viewing a LOCAL author's empty profile does neither (an empty local profile
 *    is just empty — it must never poll);
 *  - the caller is NEVER blocked on remote I/O: `syncOnProfileView` resolves
 *    before any network call settles.
 */

const actorFindOne = vi.fn();
const actorUpdateOne = vi.fn(async () => undefined);
vi.mock('../../models/FederatedActor', () => ({
  default: {
    findOne: (...args: unknown[]) => actorFindOne(...args),
    updateOne: (...args: unknown[]) => actorUpdateOne(...(args as [])),
    findOneAndUpdate: vi.fn(async () => null),
  },
}));

vi.mock('../../models/Post', () => ({
  Post: { updateMany: vi.fn(async () => undefined) },
}));

/** Resolves only when the test lets it — proves the request path never awaits it. */
let releaseOutboxSync: (() => void) | undefined;
const syncOutboxPostsDetailed = vi.fn(
  () => new Promise<{ syncedCount: number; shouldStampCooldown: boolean }>((resolve) => {
    releaseOutboxSync = () => resolve({ syncedCount: 0, shouldStampCooldown: true });
  }),
);
const refreshActorInBackground = vi.fn();
const fetchRemoteActor = vi.fn(async () => null);

vi.mock('../../connectors/activitypub/ActivityPubConnector', () => ({
  activityPubConnector: {
    fetchRemoteActor: (...a: unknown[]) => fetchRemoteActor(...(a as [])),
    refreshActorInBackground: (...a: unknown[]) => refreshActorInBackground(...(a as [])),
    syncOutboxPostsDetailed: (...a: unknown[]) => syncOutboxPostsDetailed(...(a as [])),
    markOutboxBackfillUnavailable: vi.fn(async () => undefined),
  },
  isPermanentlyUnavailableOutboxReason: () => false,
}));

vi.mock('../../connectors/activitypub/constants', () => ({ FEDERATION_ENABLED: true }));
vi.mock('../../connectors/atproto/constants', () => ({ ATPROTO_ENABLED: false }));
vi.mock('../../connectors/index', () => ({ connectorRegistry: { connectorFor: () => undefined } }));

const getUserById = vi.fn(async () => ({ id: 'local1', type: 'user', username: 'local' }));
vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ getUserById: (...a: unknown[]) => getUserById(...(a as [])) }),
}));

import { federatedProfileSync } from '../../connectors/federatedProfileSync';

/** A cached federated actor row, never synced before. */
function federatedActor(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'actor1',
    uri: 'https://remote.example/users/alice',
    acct: 'alice@remote.example',
    outboxUrl: 'https://remote.example/users/alice/outbox',
    oxyUserId: 'fed1',
    lastFetchedAt: new Date(),
    ...overrides,
  };
}

function mockActorLookup(actor: unknown) {
  actorFindOne.mockReturnValue({ lean: () => Promise.resolve(actor) });
}

beforeEach(() => {
  vi.clearAllMocks();
  releaseOutboxSync = undefined;
  fetchRemoteActor.mockResolvedValue(null);
});

describe('federatedProfileSync.syncOnProfileView', () => {
  it('reports pending and syncs the outbox for a known federated author', async () => {
    mockActorLookup(federatedActor());

    const pending = await federatedProfileSync.syncOnProfileView('fed1');

    expect(pending).toBe(true);
    // The background task is detached, so let its microtasks run before asserting.
    await vi.waitFor(() => expect(syncOutboxPostsDetailed).toHaveBeenCalledOnce());
    expect(refreshActorInBackground).toHaveBeenCalledOnce();
  });

  it('resolves without waiting for the outbox sync to finish', async () => {
    mockActorLookup(federatedActor());

    // The mocked sync never settles until the test releases it. If the request
    // path awaited it, this would hang instead of resolving.
    await expect(federatedProfileSync.syncOnProfileView('fed1')).resolves.toBe(true);
    await vi.waitFor(() => expect(releaseOutboxSync).toBeDefined());
    releaseOutboxSync?.();
  });

  it('does NOT report pending for a local author, and never syncs an outbox', async () => {
    mockActorLookup(null);
    // A local Oxy user has no `federation.actorUri`, so the background probe stops.
    getUserById.mockResolvedValue({ id: 'local1', type: 'user', username: 'local' });

    const pending = await federatedProfileSync.syncOnProfileView('local1');

    expect(pending).toBe(false);
    await vi.waitFor(() => expect(getUserById).toHaveBeenCalledWith('local1'));
    expect(syncOutboxPostsDetailed).not.toHaveBeenCalled();
    expect(refreshActorInBackground).not.toHaveBeenCalled();
  });

  it('does NOT report pending once the outbox backfill is complete', async () => {
    mockActorLookup(federatedActor({
      outboxBackfill: {
        outboxUrl: 'https://remote.example/users/alice/outbox',
        status: 'complete',
      },
    }));

    await expect(federatedProfileSync.syncOnProfileView('fed1')).resolves.toBe(false);
  });

  it('does NOT report pending when the outbox is permanently unavailable', async () => {
    mockActorLookup(federatedActor({
      outboxBackfill: {
        outboxUrl: 'https://remote.example/users/alice/outbox',
        status: 'unavailable',
      },
    }));

    await expect(federatedProfileSync.syncOnProfileView('fed1')).resolves.toBe(false);
  });

  it('does NOT report pending inside the outbox-sync cooldown window', async () => {
    mockActorLookup(federatedActor({ lastOutboxSyncAt: new Date() }));

    await expect(federatedProfileSync.syncOnProfileView('fed1')).resolves.toBe(false);
  });

  it('reports pending again once the cooldown window has elapsed', async () => {
    const sixteenMinutesAgo = new Date(Date.now() - 16 * 60 * 1000);
    mockActorLookup(federatedActor({ lastOutboxSyncAt: sixteenMinutesAgo }));

    await expect(federatedProfileSync.syncOnProfileView('fed1')).resolves.toBe(true);
  });

  it('never throws when the actor lookup fails', async () => {
    actorFindOne.mockReturnValue({ lean: () => Promise.reject(new Error('mongo down')) });

    await expect(federatedProfileSync.syncOnProfileView('fed1')).resolves.toBe(false);
  });
});
