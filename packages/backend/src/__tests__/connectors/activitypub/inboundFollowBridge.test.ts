import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Inbound Follow → Oxy follow-graph bridge (Phase 2).
 *
 * A fediverse Follow must become a REAL Oxy edge, not just a Mention-local
 * `FederatedFollow` row. `handleIncomingFollow` therefore:
 *   1. requires the follower actor's `oxyUserId` (throws `ActorResolutionPendingError`
 *      so the BullMQ inbox job retries when the actor is not yet resolved),
 *   2. skips self-follows,
 *   3. calls oxy-api `POST /federation/follow` (action `follow`) BEFORE sending the
 *      Accept, so a retry never spams Accepts,
 *   4. sends the Accept, then
 *   5. creates a fail-soft follow notification.
 *
 * `handleUndo(Follow)` mirrors it: it locates the row first (idempotent no-op when
 * absent), removes the Oxy edge (only when the actor resolved) BEFORE deleting the
 * local row.
 *
 * The actor and follow rows are REAL Postgres rows. They used to be mocked
 * models, and that made two of these assertions vacuous: "no FederatedFollow row
 * was written" was `expect(followFindOneAndUpdate).not.toHaveBeenCalled()`, which
 * a handler could satisfy by writing the row through any other call, and
 * "removes the Oxy edge BEFORE deleting the local row" compared invocation orders
 * of two fakes without either the edge or the row existing. Here the row is
 * seeded, the real handler runs, and the table is read back.
 *
 * Everything else keeps its double: crypto, the Oxy client and the notification
 * fan-out are network, and `resolveOxyUser` is overridden on the real `constants`
 * module (it otherwise `require()`s the whole server). `deliveryService.sendAccept`
 * is spied so call order can be asserted.
 */

const mocks = vi.hoisted(() => ({
  getPublicKey: vi.fn(),
  signViaOxy: vi.fn(),
  signRequest: vi.fn(),
  getServiceOxyClient: vi.fn(),
  makeServiceRequest: vi.fn(),
  resolveOxyUser: vi.fn(),
  createNotification: vi.fn(),
  persistRemoteMedia: vi.fn(),
  recordAccess: vi.fn(),
  postCreatorCreate: vi.fn(),
  loggerWarn: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
  loggerDebug: vi.fn(),
  isFediverseSharingEnabledFromUser: vi.fn(),
}));

vi.mock('../../../utils/logger', () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    debug: mocks.loggerDebug,
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock('../../../connectors/activitypub/crypto', () => ({
  getPublicKey: mocks.getPublicKey,
  signViaOxy: mocks.signViaOxy,
  signRequest: mocks.signRequest,
}));

vi.mock('../../../utils/oxyHelpers', () => ({
  getServiceOxyClient: mocks.getServiceOxyClient,
}));

vi.mock('../../../utils/notificationUtils', () => ({
  createNotification: mocks.createNotification,
  createMentionNotifications: vi.fn(),
  createWelcomeNotification: vi.fn(),
  createBatchNotifications: vi.fn(),
}));

vi.mock('../../../services/mediaCache/cacheWorker', () => ({
  persistRemoteMediaForFederatedOwnerDetailed: mocks.persistRemoteMedia,
}));

vi.mock('../../../services/mediaCache/cacheStore', () => ({
  recordAccessAndMaybeEnqueue: mocks.recordAccess,
}));

vi.mock('../../../services/fediverseSharing', () => ({
  isFediverseSharingEnabledFromUser: (...args: unknown[]) =>
    mocks.isFediverseSharingEnabledFromUser(...args),
}));

vi.mock('../../../services/serviceRegistry', () => ({
  getPostCreator: () => ({ create: mocks.postCreatorCreate }),
  registerPostFederator: vi.fn(),
  registerPostCreator: vi.fn(),
  getPostFederator: vi.fn(),
}));

// `resolveOxyUser` (in the real constants module) resolves the LOCAL user a Follow
// targets by `require()`-ing the whole server; override just that export while
// preserving every other real constant the connector graph reads at import.
vi.mock('../../../connectors/activitypub/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../connectors/activitypub/constants')>();
  return { ...actual, resolveOxyUser: mocks.resolveOxyUser };
});

import { closePostgres, connectPostgres } from '../../../db/postgres';
import {
  clearFederationScope,
  federationScope,
  readFollows,
  seedActor,
  seedFollow,
} from '../../helpers/federationFixtures';
import { deliveryService } from '../../../connectors/activitypub/delivery.service';
import { inboxProcessingService } from '../../../connectors/activitypub/inbox.service';
// The follow-protocol dispatch (incl. the deferral throw) is owned by the engine,
// so the follow path now throws the ENGINE's ActorResolutionPendingError.
import { ActorResolutionPendingError } from '@oxyhq/federation/node';

const scope = federationScope('inbound-follow-bridge');
const actorUri = `${scope.origin}/users/bob`;
const localActorUri = 'https://mention.earth/ap/users/alice';
const followActivityId = `${actorUri}/follows/1`;

/**
 * `handleIncomingFollow` reads the follower's oxyUserId through
 * `getOrFetchActor`, which returns a FRESH cached row without any network I/O —
 * so a seeded row with a current `lastFetchedAt` is the whole fixture.
 */
function seedFollowerActor(oxyUserId: string | null): Promise<unknown> {
  return seedActor(scope, {
    username: 'bob',
    uri: actorUri,
    oxyUserId,
    lastFetchedAt: new Date(),
  });
}

function followActivity() {
  return {
    id: followActivityId,
    type: 'Follow' as const,
    actor: actorUri,
    object: localActorUri,
  };
}

function undoFollowActivity() {
  return {
    id: `${followActivityId}/undo`,
    type: 'Undo' as const,
    actor: actorUri,
    object: {
      id: followActivityId,
      type: 'Follow' as const,
      actor: actorUri,
      object: localActorUri,
    },
  };
}

const sendAcceptSpy = vi.spyOn(deliveryService, 'sendAccept');

// The Follow targets local user `alice`; the scope's own local id keeps this
// suite's rows separate from every other file's in the shared database.
const localOxyUserId = scope.localUserId;

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearFederationScope(scope);

  mocks.getServiceOxyClient.mockReturnValue({ makeServiceRequest: mocks.makeServiceRequest });
  mocks.makeServiceRequest.mockResolvedValue({ created: true, counts: { followers: 1, following: 0 } });
  mocks.resolveOxyUser.mockResolvedValue({ _id: localOxyUserId });
  mocks.createNotification.mockResolvedValue(undefined);
  sendAcceptSpy.mockResolvedValue(undefined);
  mocks.isFediverseSharingEnabledFromUser.mockReturnValue(true);
});

afterEach(async () => {
  await clearFederationScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('handleIncomingFollow — Oxy follow-graph bridge', () => {
  it('bridges the follow (correct payload) BEFORE sending Accept, records the row, then notifies', async () => {
    await seedFollowerActor('oxy_bob');

    await inboxProcessingService.processInboxActivity(followActivity(), actorUri);

    expect(mocks.makeServiceRequest).toHaveBeenCalledWith('POST', '/federation/follow', {
      followerUserId: 'oxy_bob',
      targetUserId: localOxyUserId,
      action: 'follow',
    });
    expect(sendAcceptSpy).toHaveBeenCalledWith(localOxyUserId, 'alice', followActivityId, actorUri);

    // Bridge strictly precedes the Accept so a retry never re-delivers Accepts.
    const bridgeOrder = mocks.makeServiceRequest.mock.invocationCallOrder[0];
    const acceptOrder = sendAcceptSpy.mock.invocationCallOrder[0];
    expect(bridgeOrder).toBeLessThan(acceptOrder);

    // The AP-side record actually landed — this is what the sharing-off cleanup
    // later enumerates to unwind the Oxy edge.
    const follows = await readFollows(scope);
    expect(follows).toHaveLength(1);
    expect(follows[0]).toMatchObject({
      localUserId: localOxyUserId,
      remoteActorUri: actorUri,
      direction: 'inbound',
      status: 'accepted',
      activityId: followActivityId,
    });

    expect(mocks.createNotification).toHaveBeenCalledWith({
      recipientId: localOxyUserId,
      actorId: 'oxy_bob',
      type: 'follow',
      entityId: 'oxy_bob',
      entityType: 'profile',
    });
  });

  it('is idempotent under redelivery — a second Follow leaves ONE row', async () => {
    await seedFollowerActor('oxy_bob');

    await inboxProcessingService.processInboxActivity(followActivity(), actorUri);
    await inboxProcessingService.processInboxActivity(followActivity(), actorUri);

    // The unique `(local_user_id, remote_actor_uri, direction)` constraint is
    // what makes this true; without it a retried delivery is a second follower.
    const follows = await readFollows(scope);
    expect(follows).toHaveLength(1);
  });

  it('throws ActorResolutionPendingError and does not bridge or Accept when the actor has no oxyUserId', async () => {
    await seedFollowerActor(null);

    await expect(
      inboxProcessingService.processInboxActivity(followActivity(), actorUri),
    ).rejects.toBeInstanceOf(ActorResolutionPendingError);

    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
    expect(sendAcceptSpy).not.toHaveBeenCalled();
    expect(await readFollows(scope)).toHaveLength(0);
  });

  it('skips the bridge and Accept for a self-follow', async () => {
    // The follower resolves to the SAME Oxy user as the follow target.
    await seedFollowerActor(localOxyUserId);

    await inboxProcessingService.processInboxActivity(followActivity(), actorUri);

    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
    expect(sendAcceptSpy).not.toHaveBeenCalled();
    expect(await readFollows(scope)).toHaveLength(0);
  });

  it('throws (job retry) and never Accepts or records the row when the bridge call fails', async () => {
    await seedFollowerActor('oxy_bob');
    mocks.makeServiceRequest.mockRejectedValueOnce(new Error('oxy-api 503'));

    await expect(
      inboxProcessingService.processInboxActivity(followActivity(), actorUri),
    ).rejects.toThrow('oxy-api 503');

    expect(sendAcceptSpy).not.toHaveBeenCalled();
    expect(await readFollows(scope)).toHaveLength(0);
  });

  it('completes the follow even when the notification fails (fail-soft)', async () => {
    await seedFollowerActor('oxy_bob');
    mocks.createNotification.mockRejectedValueOnce(new Error('notif backend down'));

    await expect(
      inboxProcessingService.processInboxActivity(followActivity(), actorUri),
    ).resolves.toBeUndefined();

    expect(mocks.makeServiceRequest).toHaveBeenCalledTimes(1);
    expect(sendAcceptSpy).toHaveBeenCalledTimes(1);
    expect(mocks.loggerWarn).toHaveBeenCalled();
  });
});

describe('handleIncomingFollow — dropped when the target has fediverse sharing off', () => {
  it('drops the follow silently right after resolving the local user, before touching the actor/bridge/Accept chain', async () => {
    mocks.isFediverseSharingEnabledFromUser.mockReturnValue(false);
    await seedFollowerActor('oxy_bob');

    await expect(
      inboxProcessingService.processInboxActivity(followActivity(), actorUri),
    ).resolves.toBeUndefined();

    // Derived from the ALREADY-resolved local user (`resolveOxyUser`'s
    // result) — no second, separate Oxy lookup for the sharing flag.
    expect(mocks.isFediverseSharingEnabledFromUser).toHaveBeenCalledWith({ _id: localOxyUserId });
    // Gate runs BEFORE the follower actor fetch — no bridge, no Accept, no follow
    // row, and (since a Reject would be unverifiable against a 404'd actor and
    // would reveal the account exists) no Reject either.
    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
    expect(sendAcceptSpy).not.toHaveBeenCalled();
    expect(await readFollows(scope)).toHaveLength(0);
    expect(mocks.createNotification).not.toHaveBeenCalled();
    expect(mocks.loggerDebug).toHaveBeenCalledWith(expect.stringContaining('alice'));
  });
});

describe('handleUndo(Follow) — Oxy follow-graph bridge', () => {
  it('removes the Oxy edge (unfollow) BEFORE deleting the local row', async () => {
    await seedFollowerActor('oxy_bob');
    await seedFollow(scope, { remoteActorUri: actorUri, direction: 'inbound', status: 'accepted' });

    // The ordering is asserted against the ROW, not against two invocation
    // counters: the bridge reads the table at the moment it is called, so a
    // delete-then-bridge implementation reports 0 here. Comparing
    // `invocationCallOrder` of two doubles could not tell the two apart, because
    // it never observes whether the delete reached the database at all.
    let followsWhenBridged = -1;
    mocks.makeServiceRequest.mockImplementation(async () => {
      followsWhenBridged = (await readFollows(scope)).length;
      return { created: false, counts: { followers: 0, following: 0 } };
    });

    await inboxProcessingService.processInboxActivity(undoFollowActivity(), actorUri);

    expect(mocks.makeServiceRequest).toHaveBeenCalledWith('POST', '/federation/follow', {
      followerUserId: 'oxy_bob',
      targetUserId: localOxyUserId,
      action: 'unfollow',
    });
    expect(followsWhenBridged).toBe(1);
    expect(await readFollows(scope)).toHaveLength(0);
  });

  it('deletes the row without bridging when the actor never resolved to an Oxy user', async () => {
    await seedFollowerActor(null);
    await seedFollow(scope, { remoteActorUri: actorUri, direction: 'inbound', status: 'accepted' });

    await inboxProcessingService.processInboxActivity(undoFollowActivity(), actorUri);

    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
    expect(await readFollows(scope)).toHaveLength(0);
  });

  it('is a no-op when no matching follow row exists (already processed)', async () => {
    await seedFollowerActor('oxy_bob');

    await inboxProcessingService.processInboxActivity(undoFollowActivity(), actorUri);

    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
    expect(await readFollows(scope)).toHaveLength(0);
  });
});
