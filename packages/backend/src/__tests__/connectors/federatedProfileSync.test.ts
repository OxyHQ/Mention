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

/**
 * The orphaned federated posts (`oxyUserId: null`) the background sync's author
 * backfill claims, plus enough of Mongo's matching to tell a `/`-terminated RANGE
 * over `federation.activityId` apart from a prefix `$regex`. The corpus holds two
 * actors whose usernames share a prefix, so a match that is not `/`-terminated
 * visibly hands one user's posts to the other.
 */
const h = vi.hoisted(() => {
  interface OrphanPost {
    activityId: string;
    oxyUserId: string | null;
  }
  const orphans: OrphanPost[] = [];

  function matchesActivityId(activityId: string, condition: Record<string, unknown>): boolean {
    if (typeof condition.$regex === 'string') return new RegExp(condition.$regex).test(activityId);
    const { $gte: gte, $lt: lt } = condition;
    if (typeof gte !== 'string' || typeof lt !== 'string') return false;
    return activityId >= gte && activityId < lt;
  }

  const postUpdateMany = vi.fn(async (
    filter: { 'federation.activityId': Record<string, unknown>; oxyUserId: string | null },
    update: { $set: { oxyUserId: string } },
  ) => {
    let modifiedCount = 0;
    for (const post of orphans) {
      if (post.oxyUserId !== filter.oxyUserId) continue;
      if (!matchesActivityId(post.activityId, filter['federation.activityId'])) continue;
      post.oxyUserId = update.$set.oxyUserId;
      modifiedCount += 1;
    }
    return { matchedCount: modifiedCount, modifiedCount };
  });

  return { orphans, postUpdateMany };
});

vi.mock('../../models/Post', () => ({
  Post: { updateMany: (...a: unknown[]) => h.postUpdateMany(...(a as Parameters<typeof h.postUpdateMany>)) },
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

/** atproto backfill: the connector the registry hands back for an atproto URI. */
const atprotoFetchPosts = vi.fn(async () => ({ posts: [] as unknown[] }));
const connectorFor = vi.fn<(uri: string) => { fetchPosts: typeof atprotoFetchPosts } | undefined>(
  () => undefined,
);
vi.mock('../../connectors/index', () => ({
  connectorRegistry: { connectorFor: (...a: unknown[]) => connectorFor(...(a as [string])) },
}));

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

/** A cached atproto (Bluesky) actor row: no AP outbox, keyed by DID. */
function atprotoActor(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'atactor1',
    protocol: 'atproto',
    uri: 'did:plc:abc123',
    acct: 'someone.bsky.social',
    oxyUserId: 'at1',
    postsCount: 0,
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
  connectorFor.mockReturnValue(undefined);
  atprotoFetchPosts.mockResolvedValue({ posts: [] });
  h.orphans.length = 0;
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

  it('does NOT report pending for an atproto actor with zero upstream posts', async () => {
    // A Bluesky account with genuinely 0 posts has nothing to import — reporting
    // pending would make the client poll "Loading posts…" forever.
    mockActorLookup(atprotoActor({ postsCount: 0 }));

    const pending = await federatedProfileSync.syncOnProfileView('at1');

    expect(pending).toBe(false);
    // The AP outbox path must never run for an atproto actor.
    expect(syncOutboxPostsDetailed).not.toHaveBeenCalled();
  });

  it('reports pending for an atproto actor with posts and no prior sync, then stamps the backfill', async () => {
    connectorFor.mockReturnValue({ fetchPosts: atprotoFetchPosts });
    mockActorLookup(atprotoActor({ postsCount: 5 }));

    const pending = await federatedProfileSync.syncOnProfileView('at1');
    expect(pending).toBe(true);

    // The background task pulls the author feed, then stamps lastOutboxSyncAt so
    // the next poll can clear — the stamp lands AFTER the import writes posts.
    await vi.waitFor(() =>
      expect(atprotoFetchPosts).toHaveBeenCalledWith('did:plc:abc123', { limit: 20 }),
    );
    await vi.waitFor(() =>
      expect(actorUpdateOne).toHaveBeenCalledWith(
        { _id: 'atactor1' },
        { $set: { lastOutboxSyncAt: expect.any(Date) } },
      ),
    );
    expect(syncOutboxPostsDetailed).not.toHaveBeenCalled();
  });

  it('clears pending for an atproto actor once the backfill has been stamped', async () => {
    // postsCount > 0 skips the zero-post short-circuit; a recent stamp inside the
    // cooldown window is what terminates the poll after the background import.
    mockActorLookup(atprotoActor({ postsCount: 5, lastOutboxSyncAt: new Date() }));

    await expect(federatedProfileSync.syncOnProfileView('at1')).resolves.toBe(false);
  });
});

describe('federatedProfileSync author backfill', () => {
  /** Let the detached background task reach the author backfill. */
  async function runSyncAndAwaitBackfill(oxyUserId: string): Promise<void> {
    syncOutboxPostsDetailed.mockResolvedValueOnce({ syncedCount: 3, shouldStampCooldown: true });
    await federatedProfileSync.syncOnProfileView(oxyUserId);
    await vi.waitFor(() => expect(h.postUpdateMany).toHaveBeenCalledOnce());
  }

  it('claims ONLY the synced actor\'s orphaned posts, never a username-prefix sibling\'s', async () => {
    // `@alice` and `@alicesmith` are different people on the same instance. An
    // activityId prefix that is not `/`-terminated matches both.
    h.orphans.push(
      { activityId: 'https://remote.example/users/alice/statuses/1', oxyUserId: null },
      { activityId: 'https://remote.example/users/alicesmith/statuses/1', oxyUserId: null },
    );
    mockActorLookup(federatedActor());

    await runSyncAndAwaitBackfill('fed1');

    expect(h.orphans).toEqual([
      { activityId: 'https://remote.example/users/alice/statuses/1', oxyUserId: 'fed1' },
      // The sibling's post must still be unclaimed.
      { activityId: 'https://remote.example/users/alicesmith/statuses/1', oxyUserId: null },
    ]);
  });

  it('treats regex metacharacters in the actor URI as literal text', async () => {
    // A dot in the remote username is a wildcard to a mongod-evaluated `$regex`,
    // so `@a.ice` would claim `@alice`'s posts (and the pattern would run over an
    // unindexable scan).
    h.orphans.push({ activityId: 'https://remote.example/users/alice/statuses/1', oxyUserId: null });
    mockActorLookup(federatedActor({
      uri: 'https://remote.example/users/a.ice',
      acct: 'a.ice@remote.example',
      outboxUrl: 'https://remote.example/users/a.ice/outbox',
    }));

    await runSyncAndAwaitBackfill('fed1');

    expect(h.orphans[0].oxyUserId).toBeNull();
  });
});
