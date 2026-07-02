import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for `runSharingCleanup` — the Delete(actor) + follower teardown
 * that runs when a user turns fediverse sharing OFF. Every dependency is
 * mocked; ordering assertions are the point of these tests, since a partial
 * run (e.g. rows deleted before the Delete activity reads them) would either
 * silently skip the broadcast or corrupt the idempotency contract.
 */

const mocks = vi.hoisted(() => ({
  deliverToFollowers: vi.fn(),
  followFind: vi.fn(),
  followDeleteMany: vi.fn(),
  actorFind: vi.fn(),
  makeServiceRequest: vi.fn(),
}));

vi.mock('../../../connectors/activitypub/follow.service', () => ({
  followService: { deliverToFollowers: mocks.deliverToFollowers },
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
  AP_CONTEXT: ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
}));

import { runSharingCleanup } from '../../../connectors/activitypub/sharingCleanup.service';

const OXY_USER_ID = 'oxy-user-1';
const USERNAME = 'alice';
const ACTOR_URI_1 = 'https://remote1.example/users/bob';
const ACTOR_URI_2 = 'https://remote2.example/users/carol';

function mockInboundFollows(rows: Array<{ remoteActorUri: string }>): void {
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
  mockInboundFollows([]);
  mockRemoteActors([]);
});

describe('runSharingCleanup', () => {
  it('builds the Delete(actor) activity and delivers it to followers BEFORE any row is deleted', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    mockInboundFollows([{ remoteActorUri: ACTOR_URI_1 }]);

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
    mockInboundFollows([{ remoteActorUri: ACTOR_URI_1 }, { remoteActorUri: ACTOR_URI_2 }]);
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
    mockInboundFollows([{ remoteActorUri: ACTOR_URI_1 }]);
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
    expect(mocks.followDeleteMany).toHaveBeenCalledWith({
      localUserId: OXY_USER_ID,
      direction: 'inbound',
      status: 'accepted',
    });
  });

  it('continues cleanup and still deletes rows even when a bridge-unfollow call fails', async () => {
    mockInboundFollows([{ remoteActorUri: ACTOR_URI_1 }, { remoteActorUri: ACTOR_URI_2 }]);
    mockRemoteActors([
      { uri: ACTOR_URI_1, oxyUserId: 'remote-oxy-1' },
      { uri: ACTOR_URI_2, oxyUserId: 'remote-oxy-2' },
    ]);
    mocks.makeServiceRequest
      .mockRejectedValueOnce(new Error('bridge down'))
      .mockResolvedValueOnce(undefined);

    const result = await runSharingCleanup(OXY_USER_ID, USERNAME);

    expect(mocks.makeServiceRequest).toHaveBeenCalledTimes(2);
    expect(result.followersRemoved).toBe(1);
    expect(mocks.followDeleteMany).toHaveBeenCalledTimes(1);
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
    mockInboundFollows([{ remoteActorUri: ACTOR_URI_1 }]);
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
