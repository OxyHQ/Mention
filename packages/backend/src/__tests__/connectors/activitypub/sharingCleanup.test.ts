import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closePostgres, connectPostgres } from '../../../db/postgres';
import {
  clearFederationScope,
  federationScope,
  readFollows,
  seedActor,
  seedFollow,
} from '../../helpers/federationFixtures';

const scope = federationScope('sharing-cleanup');

/**
 * Unit tests for `runSharingCleanup` — the Delete(actor) + follower teardown
 * that runs when a user turns fediverse sharing OFF.
 *
 * The follow and actor ROWS are real, because the load-bearing claim here is
 * that the delete is ID-SCOPED: a failed bridge must leave its row behind for
 * the retry, and a fresh inbound Follow arriving mid-run must not be swept up.
 * With `deleteMany` mocked, both were asserted as "called with this filter",
 * which cannot distinguish an ID-scoped delete from a predicate-scoped one that
 * happens to be built from the same ids.
 *
 * Ordering is still asserted, and still matters — a row deleted before the
 * Delete activity reads it silently skips the broadcast — but the observations
 * are now taken FROM the table at the moment each stage runs.
 */

const mocks = vi.hoisted(() => ({
  deliverToFollowers: vi.fn(),
  makeServiceRequest: vi.fn(),
  getFediverseSharingStateById: vi.fn(),
}));

vi.mock('../../../connectors/activitypub/delivery.service', () => ({
  deliveryService: { deliverToFollowers: mocks.deliverToFollowers },
}));

vi.mock('../../../services/fediverseSharing', () => ({
  getFediverseSharingStateById: (...args: unknown[]) => mocks.getFediverseSharingStateById(...args),
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

const OXY_USER_ID = scope.localUserId;
const USERNAME = 'alice';
const ACTOR_URI_1 = `${scope.origin}/users/bob`;
const ACTOR_URI_2 = `${scope.origin}/users/carol`;

/** Seed the inbound follow rows the cleanup will enumerate. */
async function seedInboundFollows(actorUris: readonly string[]): Promise<void> {
  for (const remoteActorUri of actorUris) {
    await seedFollow(scope, { remoteActorUri, direction: 'inbound', status: 'accepted' });
  }
}

/** Seed the remote actor rows the bridge-unfollow resolves owners from. */
async function seedRemoteActors(rows: ReadonlyArray<{ uri: string; oxyUserId?: string }>): Promise<void> {
  for (const [index, row] of rows.entries()) {
    await seedActor(scope, {
      username: `remote${index}`,
      uri: row.uri,
      oxyUserId: row.oxyUserId ?? null,
    });
  }
}

/** The remote actor URIs of the follow rows still present. */
async function survivingActorUris(): Promise<string[]> {
  return (await readFollows(scope)).map((row) => row.remoteActorUri).sort();
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  await clearFederationScope(scope);
  mocks.deliverToFollowers.mockResolvedValue(undefined);
  mocks.makeServiceRequest.mockResolvedValue(undefined);
  // Every test in this file simulates the job running because sharing is
  // (still) OFF — the "spurious-queue guard" describe block below exercises
  // the other tri-state outcomes explicitly.
  mocks.getFediverseSharingStateById.mockResolvedValue('disabled');
});

describe('runSharingCleanup — spurious-queue guard (tri-state)', () => {
  it('re-checks the state directly against Oxy, bypassing Redis, as the FIRST step', async () => {
    let rowsWhenGuarded = -1;
    mocks.getFediverseSharingStateById.mockImplementation(async () => {
      rowsWhenGuarded = (await readFollows(scope)).length;
      return 'disabled';
    });
    await seedInboundFollows([ACTOR_URI_1]);
    await seedRemoteActors([{ uri: ACTOR_URI_1, oxyUserId: 'remote-oxy-1' }]);

    await runSharingCleanup(OXY_USER_ID, USERNAME);

    expect(mocks.getFediverseSharingStateById).toHaveBeenCalledWith(OXY_USER_ID);
    // The guard is the FIRST step: it runs while the row is still there, and the
    // cleanup only reaches the table afterwards.
    expect(rowsWhenGuarded).toBe(1);
  });

  it("'enabled': no-ops (zero delivery, zero bridge calls, zero deletions) — the queued job was spurious", async () => {
    mocks.getFediverseSharingStateById.mockResolvedValue('enabled');
    await seedInboundFollows([ACTOR_URI_1]);
    await seedRemoteActors([{ uri: ACTOR_URI_1, oxyUserId: 'remote-oxy-1' }]);

    const result = await runSharingCleanup(OXY_USER_ID, USERNAME);

    expect(result).toEqual({ deletesSent: 0, followersRemoved: 0 });
    expect(mocks.deliverToFollowers).not.toHaveBeenCalled();
    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
    // The row survives untouched — a spurious job must not tear anything down.
    expect(await survivingActorUris()).toEqual([ACTOR_URI_1]);
  });

  it("'disabled': proceeds with cleanup (the expected case)", async () => {
    mocks.getFediverseSharingStateById.mockResolvedValue('disabled');
    await seedInboundFollows([ACTOR_URI_1]);
    await seedRemoteActors([{ uri: ACTOR_URI_1, oxyUserId: 'remote-oxy-1' }]);

    const result = await runSharingCleanup(OXY_USER_ID, USERNAME);

    expect(result).toEqual({ deletesSent: 1, followersRemoved: 1 });
    expect(mocks.deliverToFollowers).toHaveBeenCalledTimes(1);
  });

  it("'unknown-user': still proceeds with cleanup — the user was deleted mid-flight, but the row teardown + Delete(actor) broadcast are still valid", async () => {
    mocks.getFediverseSharingStateById.mockResolvedValue('unknown-user');
    await seedInboundFollows([ACTOR_URI_1]);
    await seedRemoteActors([{ uri: ACTOR_URI_1, oxyUserId: 'remote-oxy-1' }]);

    const result = await runSharingCleanup(OXY_USER_ID, USERNAME);

    expect(result).toEqual({ deletesSent: 1, followersRemoved: 1 });
    expect(mocks.deliverToFollowers).toHaveBeenCalledTimes(1);
  });

  it("'unavailable': THROWS so the BullMQ job retries, without touching any row — fail-open here would silently lose real teardown during an outage", async () => {
    mocks.getFediverseSharingStateById.mockResolvedValue('unavailable');
    await seedInboundFollows([ACTOR_URI_1]);

    await expect(runSharingCleanup(OXY_USER_ID, USERNAME)).rejects.toThrow(/unavailable/i);

    expect(mocks.deliverToFollowers).not.toHaveBeenCalled();
    expect(await survivingActorUris()).toEqual([ACTOR_URI_1]);
  });
});

describe('runSharingCleanup', () => {
  it('builds the Delete(actor) activity and delivers it to followers BEFORE any row is deleted', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    await seedInboundFollows([ACTOR_URI_1]);

    // The broadcast reads the follow rows to pick its inboxes, so it must run
    // while they still exist.
    let rowsWhenDelivered = -1;
    mocks.deliverToFollowers.mockImplementation(async () => {
      rowsWhenDelivered = (await readFollows(scope)).length;
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
    expect(rowsWhenDelivered).toBe(1);
    expect(await survivingActorUris()).toEqual([]);
  });

  it('bridge-unfollows only inbound followers with a resolvable FederatedActor.oxyUserId, skipping ones without', async () => {
    await seedInboundFollows([ACTOR_URI_1, ACTOR_URI_2]);
    await seedRemoteActors([
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
    await seedInboundFollows([ACTOR_URI_1]);
    await seedRemoteActors([{ uri: ACTOR_URI_1, oxyUserId: 'remote-oxy-1' }]);

    const callOrder: string[] = [];
    let rowsWhenBridged = -1;
    mocks.deliverToFollowers.mockImplementation(async () => { callOrder.push('deliver'); });
    mocks.makeServiceRequest.mockImplementation(async () => {
      callOrder.push('bridge-unfollow');
      rowsWhenBridged = (await readFollows(scope)).length;
    });

    await runSharingCleanup(OXY_USER_ID, USERNAME);

    expect(callOrder).toEqual(['deliver', 'bridge-unfollow']);
    // The bridge ran while the row was still present, and the row is gone after.
    expect(rowsWhenBridged).toBe(1);
    expect(await survivingActorUris()).toEqual([]);
  });

  it('never deletes another local user\'s follow row for the same remote actor', async () => {
    // The scope the ID-scoped delete protects. Both users are followed by the
    // SAME remote actor, and only one of them is running a cleanup — a delete
    // keyed on the actor (or on anything other than the row ids this run
    // enumerated) takes the other user's follower with it, silently.
    const OTHER_USER = scope.user('other');
    await seedInboundFollows([ACTOR_URI_1]);
    await seedFollow(scope, {
      localUserId: OTHER_USER,
      remoteActorUri: ACTOR_URI_1,
      direction: 'inbound',
      status: 'accepted',
    });
    await seedRemoteActors([{ uri: ACTOR_URI_1, oxyUserId: 'remote-oxy-1' }]);

    await runSharingCleanup(OXY_USER_ID, USERNAME);

    const surviving = await readFollows(scope);
    expect(surviving).toHaveLength(1);
    expect(surviving[0]).toMatchObject({ localUserId: OTHER_USER, remoteActorUri: ACTOR_URI_1 });
  });

  it('on partial bridge failure: deletes ONLY the bridged/unbridgeable rows (ID-scoped) and THROWS so the job retries', async () => {
    await seedInboundFollows([ACTOR_URI_1, ACTOR_URI_2]);
    await seedRemoteActors([
      { uri: ACTOR_URI_1, oxyUserId: 'remote-oxy-1' },
      { uri: ACTOR_URI_2, oxyUserId: 'remote-oxy-2' },
    ]);
    mocks.makeServiceRequest
      .mockResolvedValueOnce(undefined) // follow-1's bridge succeeds
      .mockRejectedValueOnce(new Error('bridge down')); // follow-2's bridge fails

    await expect(runSharingCleanup(OXY_USER_ID, USERNAME)).rejects.toThrow(/1 of 2/);

    // Only the succeeded row is deleted — the failed row MUST survive so a retry
    // has data to re-attempt the bridge against. This is the assertion the
    // mocked `deleteMany` could not make: it compared a filter, not the table.
    expect(await survivingActorUris()).toEqual([ACTOR_URI_2]);
  });

  it('on full success (bridged or nothing to bridge): deletes every row and does not throw', async () => {
    await seedInboundFollows([ACTOR_URI_1, ACTOR_URI_2]);
    await seedRemoteActors([{ uri: ACTOR_URI_1, oxyUserId: 'remote-oxy-1' }]);
    // ACTOR_URI_2 has no actor row — nothing to bridge, still deletable.

    const result = await runSharingCleanup(OXY_USER_ID, USERNAME);

    expect(await survivingActorUris()).toEqual([]);
    expect(result).toEqual({ deletesSent: 2, followersRemoved: 1 });
  });

  it('retry: a second run against only the previously-failed row converges (bridges, deletes, no throw)', async () => {
    await seedInboundFollows([ACTOR_URI_1, ACTOR_URI_2]);
    await seedRemoteActors([
      { uri: ACTOR_URI_1, oxyUserId: 'remote-oxy-1' },
      { uri: ACTOR_URI_2, oxyUserId: 'remote-oxy-2' },
    ]);
    mocks.makeServiceRequest
      .mockResolvedValueOnce(undefined) // follow-1 succeeds
      .mockRejectedValueOnce(new Error('bridge down')); // follow-2 fails

    await expect(runSharingCleanup(OXY_USER_ID, USERNAME)).rejects.toThrow();
    // No simulation needed: the table IS the state a retry would find.
    expect(await survivingActorUris()).toEqual([ACTOR_URI_2]);

    mocks.deliverToFollowers.mockClear();
    mocks.makeServiceRequest.mockClear();
    mocks.makeServiceRequest.mockResolvedValue(undefined); // the transient failure is gone now

    const second = await runSharingCleanup(OXY_USER_ID, USERNAME);

    expect(second).toEqual({ deletesSent: 1, followersRemoved: 1 });
    expect(await survivingActorUris()).toEqual([]);
  });

  it('no-ops on zero inbound follows — no delivery, no bridge calls, no deletion, zeros returned', async () => {
    // No inbound follow rows seeded.

    const result = await runSharingCleanup(OXY_USER_ID, USERNAME);

    expect(mocks.deliverToFollowers).not.toHaveBeenCalled();
    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
    expect(result).toEqual({ deletesSent: 0, followersRemoved: 0 });
  });

  it('is idempotent — re-running after the rows are gone is a pure no-op', async () => {
    await seedInboundFollows([ACTOR_URI_1]);
    await seedRemoteActors([{ uri: ACTOR_URI_1, oxyUserId: 'remote-oxy-1' }]);

    const first = await runSharingCleanup(OXY_USER_ID, USERNAME);
    expect(first).toEqual({ deletesSent: 1, followersRemoved: 1 });

    mocks.deliverToFollowers.mockClear();
    mocks.makeServiceRequest.mockClear();
    // Nothing to simulate: the first run really deleted the row.
    expect(await survivingActorUris()).toEqual([]);

    const second = await runSharingCleanup(OXY_USER_ID, USERNAME);

    expect(second).toEqual({ deletesSent: 0, followersRemoved: 0 });
    expect(mocks.deliverToFollowers).not.toHaveBeenCalled();
    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
  });
});

afterEach(async () => {
  await clearFederationScope(scope);
});

afterAll(async () => {
  await closePostgres();
});
