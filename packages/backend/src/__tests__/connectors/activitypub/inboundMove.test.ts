import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Inbound ActivityPub `Move` → Oxy `POST /federation/move` → adoption here.
 *
 * Drives the engine's `onMove` handler (`applyInboundMove`); the engine's own
 * shape check (`parseInboundMove`) is `@oxy.so/federation`'s suite's subject. The
 * Oxy client is the only network double; its answer stands in for Oxy's
 * verification (alias + fresh `movedTo`), which is Oxy's own suite's subject.
 *
 * The adoption half is REAL Postgres: the old actor's posts must become the
 * target user's through the source-identity projection, and a post the user
 * imported from that account must end up collapsed under the federated copy of
 * the same source post — one card, both objects still stored, the conversation
 * still on the copy — and must come back when the projection is withdrawn.
 * Local accounts that followed the old actor send it `Undo(Follow)` and lose the
 * stale outbound edge.
 */

const mocks = vi.hoisted(() => ({
  makeServiceRequest: vi.fn(),
  getUsersByIds: vi.fn(),
  dispatcherConfig: undefined as undefined | { onMove?: unknown },
  loggerWarn: vi.fn(),
  loggerInfo: vi.fn(),
  invalidateUsers: vi.fn(),
  lookupOxyIdentities: vi.fn(),
}));

vi.mock('../../../utils/logger', () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock('../../../connectors/activitypub/crypto', () => ({
  getPublicKey: vi.fn(),
  signViaOxy: vi.fn(),
  signRequest: vi.fn(),
}));

vi.mock('../../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ makeServiceRequest: mocks.makeServiceRequest, getUsersByIds: mocks.getUsersByIds }),
}));

vi.mock('@oxy.so/federation/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oxy.so/federation/node')>();
  return {
    ...actual,
    createInboundDispatcher: (config: Parameters<typeof actual.createInboundDispatcher>[0]) => {
      mocks.dispatcherConfig = config;
      return actual.createInboundDispatcher(config);
    },
  };
});

vi.mock('../../../utils/notificationUtils', () => ({
  createNotification: vi.fn(),
  createMentionNotifications: vi.fn(),
  createWelcomeNotification: vi.fn(),
  createBatchNotifications: vi.fn(),
}));

vi.mock('../../../services/serviceRegistry', () => ({
  getPostCreator: () => ({ create: vi.fn() }),
  registerPostFederator: vi.fn(),
  registerPostCreator: vi.fn(),
  getPostFederator: vi.fn(),
}));

vi.mock('../../../connectors/activitypub/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../connectors/activitypub/constants')>();
  return { ...actual, resolveOxyUser: vi.fn() };
});

vi.mock('../../../services/userSummaryCache', () => ({ invalidate: mocks.invalidateUsers }));
vi.mock('../../../connectors/oxyIdentity', () => ({
  lookupOxyIdentities: mocks.lookupOxyIdentities,
  resolveOxyIdentity: vi.fn(),
}));

import { eq, inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { postImports } from '../../../db/schema/imports';
import { postEquivalenceClusters, postEquivalenceMembers, posts } from '../../../db/schema/posts';
import { federatedFollows } from '../../../db/schema/federation';
import { findClusterByPostId } from '../../../db/posts/postEquivalenceRepository';
import { clearFederationScope, federationScope, seedActor, seedFollow, seedPost } from '../../helpers/federationFixtures';
import '../../../connectors/activitypub/inbox.service';
import { parseInboundActivity } from '../../../connectors/activitypub/apSchemas';
import { applyInboundMove } from '../../../connectors/activitypub/move.service';
import { deliveryService } from '../../../connectors/activitypub/delivery.service';
import { reconcileActorIdentityProjection } from '../../../services/ActorIdentityProjectionService';
import { collapseImportedCopies } from '../../../services/PostEquivalenceService';

const scope = federationScope('inbound-move');
const OLD_ACTOR = `${scope.origin}/users/alice`;
const TARGET_ACTOR = 'https://mention.earth/ap/users/alice';
const SHADOW = scope.user('old-shadow');
const TARGET = scope.user('alice');
const REPLIER = scope.user('replier');
const MOVE_ID = `${OLD_ACTOR}#moves/1`;
const MOVE = { activityId: MOVE_ID, oldActorUri: OLD_ACTOR, targetActorUri: TARGET_ACTOR };

function move(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: MOVE_ID, type: 'Move', actor: OLD_ACTOR, object: OLD_ACTOR, target: TARGET_ACTOR, ...overrides };
}

function oxyApplied(overrides: Record<string, unknown> = {}) {
  return {
    moveId: 'move-1',
    replayed: false,
    oldActorUri: OLD_ACTOR,
    targetActorUri: TARGET_ACTOR,
    oldUserId: SHADOW,
    targetUserId: TARGET,
    followersMoved: 3,
    alreadyFollowing: 0,
    skippedBlocked: 0,
    ...overrides,
  };
}

/** The SDK's shape for a non-2xx: `status` and the body's `error` as `code`. */
function oxyError(status: number, code?: string): Error {
  return Object.assign(new Error(code ?? `HTTP ${status}`), { status, ...(code ? { code } : {}) });
}

const trackedPostIds: string[] = [];

async function federatedCopy(statusId: string, text: string) {
  const post = await seedPost(scope, {
    oxyUserId: SHADOW,
    authorship: [{ oxyUserId: SHADOW, role: 'owner', status: 'accepted' }],
    content: { variants: [{ source: 'author', text, tag: 'en' }] },
    federation: {
      actorUri: OLD_ACTOR,
      activityId: `${OLD_ACTOR}/statuses/${statusId}`,
      url: `${scope.origin}/@alice/${statusId}`,
    },
  });
  trackedPostIds.push(post.id);
  return post;
}

async function importedPost(statusId: string, text: string) {
  const post = await seedPost(scope, {
    oxyUserId: TARGET,
    authorship: [{ oxyUserId: TARGET, role: 'owner', status: 'accepted' }],
    content: { variants: [{ source: 'author', text, tag: 'en' }] },
  });
  await getDb().insert(postImports).values({
    postId: post.id,
    oxyUserId: TARGET,
    platform: 'mastodon',
    sourceId: statusId,
    sourceUrl: `${scope.origin}/@alice/${statusId}`,
    importBatchId: 'move-job-1',
  });
  trackedPostIds.push(post.id);
  return post;
}

async function row(id: string) {
  const [found] = await getDb().select().from(posts).where(eq(posts.id, id));
  return found;
}

beforeAll(connectPostgres);
afterAll(closePostgres);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.invalidateUsers.mockResolvedValue(undefined);
  mocks.lookupOxyIdentities.mockResolvedValue([]);
  mocks.getUsersByIds.mockResolvedValue([]);
});

afterEach(async () => {
  const members = trackedPostIds.length
    ? await getDb().select({ clusterId: postEquivalenceMembers.clusterId }).from(postEquivalenceMembers)
      .where(inArray(postEquivalenceMembers.postId, trackedPostIds))
    : [];
  if (members.length) {
    await getDb().delete(postEquivalenceClusters).where(inArray(postEquivalenceClusters.id, members.map((m) => m.clusterId)));
  }
  trackedPostIds.splice(0);
  await clearFederationScope(scope);
});

describe('Move schema', () => {
  it('validates a Move with bare or embedded references (it used to be dropped as invalid)', () => {
    expect(parseInboundActivity(move()).ok).toBe(true);
    expect(parseInboundActivity(move({ target: { id: TARGET_ACTOR, type: 'Person' } })).ok).toBe(true);
    expect(parseInboundActivity(move({ target: undefined })).ok).toBe(false);
    expect(parseInboundActivity(move({ id: undefined })).ok).toBe(false);
  });
});

describe('inbound Move → Oxy', () => {
  it('is the inbox dispatcher onMove handler', () => {
    expect(mocks.dispatcherConfig?.onMove).toBe(applyInboundMove);
  });

  it('forwards the Move to POST /federation/move', async () => {
    mocks.makeServiceRequest.mockResolvedValue(oxyApplied());
    await seedActor(scope, { username: 'alice', uri: OLD_ACTOR, oxyUserId: SHADOW, lastFetchedAt: new Date() });

    await applyInboundMove(MOVE);

    expect(mocks.makeServiceRequest).toHaveBeenCalledTimes(1);
    expect(mocks.makeServiceRequest).toHaveBeenCalledWith('POST', '/federation/move', {
      oldActorUri: OLD_ACTOR,
      targetActorUri: TARGET_ACTOR,
      activityId: MOVE_ID,
    });
  });

  it('logs a 4xx refusal with its code and drops it (the job succeeds, nothing is adopted)', async () => {
    mocks.makeServiceRequest.mockRejectedValue(oxyError(422, 'alias_missing'));
    await seedActor(scope, { username: 'alice', uri: OLD_ACTOR, oxyUserId: SHADOW, lastFetchedAt: new Date() });
    const copy = await federatedCopy('1', 'hello from mastodon');

    await expect(applyInboundMove(MOVE)).resolves.toBeUndefined();

    expect(mocks.loggerWarn).toHaveBeenCalledWith('[Federation] Move refused by Oxy', expect.objectContaining({
      code: 'alias_missing',
      status: 422,
      activityId: MOVE_ID,
    }));
    expect((await row(copy.id)).oxyUserId).toBe(SHADOW);
  });

  it.each([
    ['a 502 (old actor unreachable)', oxyError(502, 'old_actor_unreachable')],
    ['a 503', oxyError(503)],
    ['a network failure', Object.assign(new Error('Network error'), { status: 0 })],
    ['a 429', oxyError(429)],
  ])('throws on %s so the inbox job retries', async (_label, error) => {
    mocks.makeServiceRequest.mockRejectedValue(error);
    await expect(applyInboundMove(MOVE)).rejects.toBe(error);
  });
});

describe('adoption after Oxy applies the Move', () => {
  it('reattributes the old actor posts and collapses a matching import under the federated copy', async () => {
    mocks.makeServiceRequest.mockResolvedValue(oxyApplied());
    await seedActor(scope, { username: 'alice', uri: OLD_ACTOR, oxyUserId: SHADOW, lastFetchedAt: new Date() });
    const copy = await federatedCopy('1', 'hello from mastodon');
    const onlyFederated = await federatedCopy('2', 'never imported');
    const reply = await seedPost(scope, {
      oxyUserId: REPLIER,
      authorship: [{ oxyUserId: REPLIER, role: 'owner', status: 'accepted' }],
      parentPostId: copy.id,
      isReply: true,
    });
    trackedPostIds.push(reply.id);
    const duplicate = await importedPost('1', 'hello from mastodon');
    const onlyImported = await importedPost('3', 'never federated');

    await applyInboundMove(MOVE);

    // The projection: the old account's posts are now the target user's.
    expect((await row(copy.id)).oxyUserId).toBe(TARGET);
    expect((await row(onlyFederated.id)).oxyUserId).toBe(TARGET);
    // One card: the import is collapsed, the federated copy rendered.
    expect((await row(copy.id)).crosspostCollapsed).toBe(false);
    expect((await row(duplicate.id)).crosspostCollapsed).toBe(true);
    expect((await row(onlyImported.id)).crosspostCollapsed).toBe(false);
    expect((await row(onlyFederated.id)).crosspostCollapsed).toBe(false);
    const cluster = await findClusterByPostId(copy.id);
    expect(cluster?.members.find((m) => m.preferred)?.postId).toBe(copy.id);
    expect(cluster?.members.map((m) => m.postId).sort()).toEqual([copy.id, duplicate.id].sort());
    // Nothing was deleted, and the conversation stays on the copy.
    expect(await row(duplicate.id)).toBeDefined();
    expect((await row(reply.id)).parentPostId).toBe(copy.id);
    expect((await row(reply.id)).oxyUserId).toBe(REPLIER);

    // The same Move again (another inbox, or a retry): Oxy replays, nothing changes.
    mocks.makeServiceRequest.mockResolvedValue(oxyApplied({ replayed: true }));
    await applyInboundMove(MOVE);
    const clusters = await getDb().select({ clusterId: postEquivalenceMembers.clusterId }).from(postEquivalenceMembers)
      .where(inArray(postEquivalenceMembers.postId, [copy.id, duplicate.id, onlyImported.id, onlyFederated.id]));
    expect(new Set(clusters.map((c) => c.clusterId)).size).toBe(1);
  });

  it('is reversible: projecting the source back splits the pair and shows both posts', async () => {
    mocks.makeServiceRequest.mockResolvedValue(oxyApplied());
    await seedActor(scope, { username: 'alice', uri: OLD_ACTOR, oxyUserId: SHADOW, lastFetchedAt: new Date() });
    const copy = await federatedCopy('1', 'hello from mastodon');
    const duplicate = await importedPost('1', 'hello from mastodon');
    await applyInboundMove(MOVE);
    expect((await row(duplicate.id)).crosspostCollapsed).toBe(true);

    // Oxy withdraws the Move; the live resolver projects the source back.
    await reconcileActorIdentityProjection({ actorUri: OLD_ACTOR, oxyUserId: SHADOW });

    expect((await row(copy.id)).oxyUserId).toBe(SHADOW);
    expect((await row(duplicate.id)).oxyUserId).toBe(TARGET);
    expect((await row(duplicate.id)).crosspostCollapsed).toBe(false);
    expect(await findClusterByPostId(duplicate.id)).toBeNull();
  });

  it('collapses an import that arrives after the Move under the copy the Move adopted', async () => {
    mocks.makeServiceRequest.mockResolvedValue(oxyApplied());
    await seedActor(scope, { username: 'alice', uri: OLD_ACTOR, oxyUserId: SHADOW, lastFetchedAt: new Date() });
    const copy = await federatedCopy('1', 'hello from mastodon');
    await applyInboundMove(MOVE);

    const late = await importedPost('1', 'hello from mastodon');
    const result = await collapseImportedCopies({ oxyUserId: TARGET, actorUris: [OLD_ACTOR], importedPostIds: [late.id] });

    expect(result.clustered).toBe(1);
    expect((await row(late.id)).crosspostCollapsed).toBe(true);
    expect((await row(copy.id)).crosspostCollapsed).toBe(false);
  });

  it('adopts nothing when Mention never cached the old actor', async () => {
    mocks.makeServiceRequest.mockResolvedValue(oxyApplied());
    await expect(applyInboundMove(MOVE)).resolves.toBeUndefined();
    expect(mocks.loggerInfo).toHaveBeenCalledWith('[Federation] Move applied', expect.objectContaining({
      adoptionSkipped: 'actor_not_cached',
      postsReattributed: 0,
    }));
  });
});

describe('local follows of the old actor', () => {
  it('sends each local follower\'s Undo(Follow) to the old actor and removes the edge, once', async () => {
    mocks.makeServiceRequest.mockResolvedValue(oxyApplied());
    await seedActor(scope, { username: 'alice', uri: OLD_ACTOR, oxyUserId: SHADOW, lastFetchedAt: new Date() });
    const bob = scope.user('bob');
    const carol = scope.user('carol');
    const unknown = scope.user('unknown');
    await seedFollow(scope, { localUserId: bob, remoteActorUri: OLD_ACTOR, direction: 'outbound', activityId: `${bob}/follows/1` });
    await seedFollow(scope, { localUserId: carol, remoteActorUri: OLD_ACTOR, direction: 'outbound', status: 'pending' });
    await seedFollow(scope, { localUserId: unknown, remoteActorUri: OLD_ACTOR, direction: 'outbound' });
    // The old actor following bob is not bob following it: untouched.
    await seedFollow(scope, { localUserId: bob, remoteActorUri: OLD_ACTOR, direction: 'inbound' });
    mocks.getUsersByIds.mockResolvedValue([{ id: bob, username: 'bob' }, { id: carol, username: 'carol' }]);
    const undo = vi.spyOn(deliveryService, 'sendUndoFollow').mockResolvedValue(true);

    await applyInboundMove(MOVE);

    expect(mocks.getUsersByIds).toHaveBeenCalledTimes(1);
    expect(undo).toHaveBeenCalledTimes(2);
    expect(undo).toHaveBeenCalledWith(bob, 'bob', OLD_ACTOR);
    expect(undo).toHaveBeenCalledWith(carol, 'carol', OLD_ACTOR);
    const remaining = await getDb()
      .select({ localUserId: federatedFollows.localUserId, direction: federatedFollows.direction })
      .from(federatedFollows)
      .where(eq(federatedFollows.remoteActorUri, OLD_ACTOR));
    // A user Oxy did not return keeps the edge rather than losing it without an Undo.
    expect(remaining).toEqual(expect.arrayContaining([
      { localUserId: bob, direction: 'inbound' },
      { localUserId: unknown, direction: 'outbound' },
    ]));
    expect(remaining).toHaveLength(2);

    // Replayed: nothing left to undo for the users already handled.
    undo.mockClear();
    mocks.makeServiceRequest.mockResolvedValue(oxyApplied({ replayed: true }));
    await applyInboundMove(MOVE);
    expect(undo).not.toHaveBeenCalled();
    undo.mockRestore();
  });

  it('sends nothing when Oxy refuses the Move', async () => {
    mocks.makeServiceRequest.mockRejectedValue(oxyError(422, 'alias_missing'));
    await seedFollow(scope, { localUserId: scope.user('bob'), remoteActorUri: OLD_ACTOR, direction: 'outbound' });
    const undo = vi.spyOn(deliveryService, 'sendUndoFollow');

    await applyInboundMove(MOVE);

    expect(undo).not.toHaveBeenCalled();
    expect(mocks.getUsersByIds).not.toHaveBeenCalled();
    undo.mockRestore();
  });
});
