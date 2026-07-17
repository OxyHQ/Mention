import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `runSharingCleanup` — the Delete(actor) + follower teardown
 * that runs when a user turns fediverse sharing OFF. Every dependency is
 * mocked; ordering assertions are the point of these tests, since a partial
 * run (e.g. rows deleted before the Delete activity reads them, or before a
 * bridge-unfollow succeeds) would either silently skip the broadcast, lose a
 * row that should have been retried, or corrupt the idempotency contract.
 */

const mocks = vi.hoisted(() => ({
  deliverToFollowers: vi.fn(),
  followFind: vi.fn(),
  followDeleteMany: vi.fn(),
  actorFind: vi.fn(),
  makeServiceRequest: vi.fn(),
  getFediverseSharingStateById: vi.fn(),
}));

vi.mock('../../../connectors/activitypub/follow.service', () => ({
  followService: { deliverToFollowers: mocks.deliverToFollowers },
}));

vi.mock('../../../services/fediverseSharing', () => ({
  getFediverseSharingStateById: (...args: unknown[]) => mocks.getFediverseSharingStateById(...args),
}));

vi.mock('../../../models/FederatedFollow', () => ({
  default: {
    find: mocks.followFind,
    deleteMany: mocks.followDeleteMany,
  },
}));

vi.mock('../../../models/FederatedActor', () => ({
  default: {
    find: mocks.actorFind,
  },
}));

vi.mock('../../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ makeServiceRequest: mocks.makeServiceRequest }),
}));

vi.mock('../../../connectors/activitypub/constants', () => ({
  actorUrl: (username: string) => `https://mention.earth/ap/users/${username}`,
}));

// `AP_CONTEXT` now lives in the shared engine; the service imports it directly.
// Mock the engine's copy to the simplified 2-element context so the Delete(actor)
// activity assertion below stays readable (the full term-declaration object is
// exercised by the engine's own golden test).
vi.mock('@oxyhq/federation', () => ({
  AP_CONTEXT: ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
}));

import { runSharingCleanup } from '../../../connectors/activitypub/sharingCleanup.service';

const OXY_USER_ID = 'oxy-user-1';
const USERNAME = 'alice';
const ACTOR_URI_1 = 'https://remote1.example/users/bob';
const ACTOR_URI_2 = 'https://remote2.example/users/carol';

function mockInboundFollows(rows: Array<{ _id: string; remoteActorUri: string }>): void {
  mocks.followFind.mockReturnValue({ lean: async () => rows });
}

function mockRemoteActors(rows: Array<{ uri: string; oxyUserId?: string }>): void {
  mocks.actorFind.mockReturnValue({ select: () => ({ lean: async () => rows }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  mocks.deliverToFollowers.mockResolvedValue(undefined);
  mocks.followDeleteMany.mockResolvedValue({ deletedCount: 0 });
  mocks.makeServiceRequest.mockResolvedValue(undefined);
  // Every test in this file simulates the job running because sharing is
  // (still) OFF — the "spurious-queue guard" describe block below exercises
  // the other tri-state outcomes explicitly.
  mocks.getFediverseSharingStateById.mockResolvedValue('disabled');
  mockInboundFollows([]);
  mockRemoteActors([]);
});

describe('runSharingCleanup — spurious-queue guard (tri-state)', () => {
  it('re-checks the state directly against Oxy, bypassing Redis, as the FIRST step', async () => {
    mocks.getFediverseSharingStateById.mockResolvedValue('disabled');
    mockInboundFollows([{ _id: 'follow-1', remoteActorUri: ACTOR_URI_1 }]);
    mockRemoteActors([{ uri: ACTOR_URI_1, oxyUserId: 'remote-oxy-1' }]);

    await runSharingCleanup(OXY_USER_ID, USERNAME);

    expect(mocks.getFediverseSharingStateById).toHaveBeenCalledWith(OXY_USER_ID);
    const guardOrder = mocks.getFediverseSharingStateById.mock.invocationCallOrder[0];
    const findOrder = mocks.followFind.mock.invocationCallOrder[0];
    expect(guardOrder).toBeLessThan(findOrder);
  });

  it("'enabled': no-ops (zero delivery, zero bridge calls, zero deletions) — the queued job was spurious", async () => {
    mocks.getFediverseSharingStateById.mockResolvedValue('enabled');
    mockInboundFollows([{ _id: 'follow-1', remoteActorUri: ACTOR_URI_1 }]);
    mockRemoteActors([{ uri: ACTOR_URI_1, oxyUserId: 'remote-oxy-1' }]);

    const result = await runSharingCleanup(OXY_USER_ID, USERNAME);

    expect(result).toEqual({ deletesSent: 0, followersRemoved: 0 });
    expect(mocks.followFind).not.toHaveBeenCalled();
    expect(mocks.deliverToFollowers).not.toHaveBeenCalled();
    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
    expect(mocks.followDeleteMany).not.toHaveBeenCalled();
  });

  it("'disabled': proceeds with cleanup (the expected case)", async () => {
    mocks.getFediverseSharingStateById.mockResolvedValue('disabled');
    mockInboundFollows([{ _id: 'follow-1', remoteActorUri: ACTOR_URI_1 }]);
    mockRemoteActors([{ uri: ACTOR_URI_1, oxyUserId: 'remote-oxy-1' }]);

    const result = await runSharingCleanup(OXY_USER_ID, USERNAME);

    expect(result).toEqual({ deletesSent: 1, followersRemoved: 1 });
    expect(mocks.deliverToFollowers).toHaveBeenCalledTimes(1);
  });

  it("'unknown-user': still proceeds with cleanup — the user was deleted mid-flight, but the row teardown + Delete(actor) broadcast are still valid", async () => {
    mocks.getFediverseSharingStateById.mockResolvedValue('unknown-user');
    mockInboundFollows([{ _id: 'follow-1', remoteActorUri: ACTOR_URI_1 }]);
    mockRemoteActors([{ uri: ACTOR_URI_1, oxyUserId: 'remote-oxy-1' }]);

    const result = await runSharingCleanup(OXY_USER_ID, USERNAME);

    expect(result).toEqual({ deletesSent: 1, followersRemoved: 1 });
    expect(mocks.deliverToFollowers).toHaveBeenCalledTimes(1);
  });

  it("'unavailable': THROWS so the BullMQ job retries, without touching any row — fail-open here would silently lose real teardown during an outage", async () => {
    mocks.getFediverseSharingStateById.mockResolvedValue('unavailable');
    mockInboundFollows([{ _id: 'follow-1', remoteActorUri: ACTOR_URI_1 }]);

    await expect(runSharingCleanup(OXY_USER_ID, USERNAME)).rejects.toThrow(/unavailable/i);

    expect(mocks.followFind).not.toHaveBeenCalled();
    expect(mocks.deliverToFollowers).not.toHaveBeenCalled();
    expect(mocks.followDeleteMany).not.toHaveBeenCalled();
  });
});

describe('runSharingCleanup', () => {
  it('builds the Delete(actor) activity and delivers it to followers BEFORE any row is deleted', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    mockInboundFollows([{ _id: 'follow-1', remoteActorUri: ACTOR_URI_1 }]);

    const callOrder: string[] = [];
    mocks.deliverToFollowers.mockImplementation(async () => { callOrder.push('deliver'); });
    mocks.followDeleteMany.mockImplementation(async () => {
      callOrder.push('delete');
      return { deletedCount: 1 };
    });

    await runSharingCleanup(OXY_USER_ID, USERNAME);

    expect(mocks.deliverToFollowers).toHaveBeenCalledWith(
      {
        '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
        id: 'https://mention.earth/ap/users/alice#delete-1700000000000',
        type: 'Delete',
        actor: 'https://mention.earth/ap/users/alice',
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        object: 'https://mention.earth/ap/users/alice',
      },
      OXY_USER_ID,
      USERNAME,
    );
    expect(callOrder).toEqual(['deliver', 'delete']);
  });

  it('bridge-unfollows only inbound followers with a resolvable FederatedActor.oxyUserId, skipping ones without', async () => {
    mockInboundFollows([
      { _id: 'follow-1', remoteActorUri: ACTOR_URI_1 },
      { _id: 'follow-2', remoteActorUri: ACTOR_URI_2 },
    ]);
    mockRemoteActors([
      { uri: ACTOR_URI_1, oxyUserId: 'remote-oxy-1' },
      { uri: ACTOR_URI_2 }, // actor known but never resolved to an Oxy user — skip
    ]);

    const result = await runSharingCleanup(OXY_USER_ID, USERNAME);

    expect(mocks.makeServiceRequest).toHaveBeenCalledTimes(1);
    expect(mocks.makeServiceRequest).toHaveBeenCalledWith('POST', '/federation/follow', {
      followerUserId: 'remote-oxy-1',
      targetUserId: OXY_USER_ID,
      action: 'unfollow',
    });
    expect(result.followersRemoved).toBe(1);
  });

  it('runs deliver -> bridge-unfollow -> row deletion, in that order', async () => {
    mockInboundFollows([{ _id: 'follow-1', remoteActorUri: ACTOR_URI_1 }]);
    mockRemoteActors([{ uri: ACTOR_URI_1, oxyUserId: 'remote-oxy-1' }]);

    const callOrder: string[] = [];
    mocks.deliverToFollowers.mockImplementation(async () => { callOrder.push('deliver'); });
    mocks.makeServiceRequest.mockImplementation(async () => { callOrder.push('bridge-unfollow'); });
    mocks.followDeleteMany.mockImplementation(async () => {
      callOrder.push('delete');
      return { deletedCount: 1 };
    });

    await runSharingCleanup(OXY_USER_ID, USERNAME);

    expect(callOrder).toEqual(['deliver', 'bridge-unfollow', 'delete']);
    expect(mocks.followDeleteMany).toHaveBeenCalledWith({ _id: { $in: ['follow-1'] } });
  });

  it('on partial bridge failure: deletes ONLY the bridged/unbridgeable rows (ID-scoped) and THROWS so the job retries', async () => {
    mockInboundFollows([
      { _id: 'follow-1', remoteActorUri: ACTOR_URI_1 },
      { _id: 'follow-2', remoteActorUri: ACTOR_URI_2 },
    ]);
    mockRemoteActors([
      { uri: ACTOR_URI_1, oxyUserId: 'remote-oxy-1' },
      { uri: ACTOR_URI_2, oxyUserId: 'remote-oxy-2' },
    ]);
    mocks.makeServiceRequest
      .mockResolvedValueOnce(undefined) // follow-1's bridge succeeds
      .mockRejectedValueOnce(new Error('bridge down')); // follow-2's bridge fails

    await expect(runSharingCleanup(OXY_USER_ID, USERNAME)).rejects.toThrow(/1 of 2/);

    // Only the succeeded row is deleted — the failed row's FederatedFollow row
    // MUST survive so a retry has data to re-attempt the bridge against.
    expect(mocks.followDeleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.followDeleteMany).toHaveBeenCalledWith({ _id: { $in: ['follow-1'] } });
  });

  it('on full success (bridged or nothing to bridge): deletes every row and does not throw', async () => {
    mockInboundFollows([
      { _id: 'follow-1', remoteActorUri: ACTOR_URI_1 },
      { _id: 'follow-2', remoteActorUri: ACTOR_URI_2 },
    ]);
    mockRemoteActors([
      { uri: ACTOR_URI_1, oxyUserId: 'remote-oxy-1' },
      // ACTOR_URI_2 has no resolvable actor — nothing to bridge, still deletable.
    ]);

    const result = await runSharingCleanup(OXY_USER_ID, USERNAME);

    expect(mocks.followDeleteMany).toHaveBeenCalledWith({ _id: { $in: ['follow-1', 'follow-2'] } });
    expect(result).toEqual({ deletesSent: 2, followersRemoved: 1 });
  });

  it('retry: a second run against only the previously-failed row converges (bridges, deletes, no throw)', async () => {
    mockInboundFollows([
      { _id: 'follow-1', remoteActorUri: ACTOR_URI_1 },
      { _id: 'follow-2', remoteActorUri: ACTOR_URI_2 },
    ]);
    mockRemoteActors([
      { uri: ACTOR_URI_1, oxyUserId: 'remote-oxy-1' },
      { uri: ACTOR_URI_2, oxyUserId: 'remote-oxy-2' },
    ]);
    mocks.makeServiceRequest
      .mockResolvedValueOnce(undefined) // follow-1 succeeds
      .mockRejectedValueOnce(new Error('bridge down')); // follow-2 fails

    await expect(runSharingCleanup(OXY_USER_ID, USERNAME)).rejects.toThrow();
    expect(mocks.followDeleteMany).toHaveBeenCalledWith({ _id: { $in: ['follow-1'] } });

    // Simulate the real DB state after that run: follow-1 is gone (deleted),
    // follow-2 survived and is the only row a retry (BullMQ re-running the same
    // job) would find.
    mocks.deliverToFollowers.mockClear();
    mocks.makeServiceRequest.mockClear();
    mocks.followDeleteMany.mockClear();
    mockInboundFollows([{ _id: 'follow-2', remoteActorUri: ACTOR_URI_2 }]);
    mocks.makeServiceRequest.mockResolvedValue(undefined); // the transient failure is gone now

    const second = await runSharingCleanup(OXY_USER_ID, USERNAME);

    expect(second).toEqual({ deletesSent: 1, followersRemoved: 1 });
    expect(mocks.followDeleteMany).toHaveBeenCalledWith({ _id: { $in: ['follow-2'] } });
  });

  it('no-ops on zero inbound follows — no delivery, no bridge calls, no deletion, zeros returned', async () => {
    mockInboundFollows([]);

    const result = await runSharingCleanup(OXY_USER_ID, USERNAME);

    expect(mocks.deliverToFollowers).not.toHaveBeenCalled();
    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
    expect(mocks.followDeleteMany).not.toHaveBeenCalled();
    expect(result).toEqual({ deletesSent: 0, followersRemoved: 0 });
  });

  it('is idempotent — re-running after the rows are gone is a pure no-op', async () => {
    mockInboundFollows([{ _id: 'follow-1', remoteActorUri: ACTOR_URI_1 }]);
    mockRemoteActors([{ uri: ACTOR_URI_1, oxyUserId: 'remote-oxy-1' }]);

    const first = await runSharingCleanup(OXY_USER_ID, USERNAME);
    expect(first).toEqual({ deletesSent: 1, followersRemoved: 1 });

    mocks.deliverToFollowers.mockClear();
    mocks.makeServiceRequest.mockClear();
    mocks.followDeleteMany.mockClear();
    // Simulate the real effect of the deleteMany call above: no inbound rows left.
    mockInboundFollows([]);

    const second = await runSharingCleanup(OXY_USER_ID, USERNAME);

    expect(second).toEqual({ deletesSent: 0, followersRemoved: 0 });
    expect(mocks.deliverToFollowers).not.toHaveBeenCalled();
    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
    expect(mocks.followDeleteMany).not.toHaveBeenCalled();
  });
});
