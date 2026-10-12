/**
 * Inbound ActivityPub `Move`: a remote account says it moved to an account here.
 *
 * The federation engine checks the shape (`actor` and `object` are the verified
 * signer, `target` an https URI other than the actor) and hands the result to
 * {@link applyInboundMove}, its `onMove` handler. Mention decides nothing about
 * whether the move is real: Oxy owns identity, so the move is forwarded to Oxy's
 * `POST /federation/move`, which checks that the target linked the old account as
 * an alias and that a fresh fetch of the old actor names the target as `movedTo`,
 * then repoints the follows and redirects the old account. Only after Oxy says
 * yes does Mention do its own part: the old account's posts here become the
 * target's, and local accounts stop following the old actor.
 *
 * Failure posture, per the inbox job's retry contract:
 *  - a network failure, a 5xx, a 408 or a 429 from Oxy THROWS, so the BullMQ
 *    inbox job retries with backoff;
 *  - any other 4xx is Oxy's considered refusal (`alias_missing`,
 *    `moved_to_mismatch`, …): logged with its code and dropped.
 * Oxy is idempotent on the activity id, and every step after it is idempotent
 * too, so a retry (or the same Move delivered to several inboxes) is safe.
 *
 * A move to ANOTHER server (remote → remote) is not Oxy's to apply today, but it
 * is still worth remembering: {@link recordRemoteMove} stores the target on the
 * old actor's row so its profile can say where the account went. That half is
 * Mention's alone and runs before the Oxy call, whatever Oxy answers.
 */

import type { InboundMove } from '@oxy.so/federation/node';
import { logger } from '../../utils/logger';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { mapWithConcurrency } from '../../utils/concurrency';
import { deleteFollow, findFollows } from '../../db/federation/followRepository';
import { reconcileActorIdentityProjection } from '../../services/ActorIdentityProjectionService';
import { collapseImportedCopies } from '../../services/PostEquivalenceService';
import { deliveryService } from './delivery.service';
import { actorService } from './actor.service';
import { OWN_DOMAINS } from './ownDomain';
import { findActorByUri, setActorMovedTo } from '../../db/federation/actorRepository';

/** The fields of Oxy's `POST /federation/move` answer this reads. */
interface FederationMoveOutcome {
  replayed: boolean;
  targetUserId: string;
  followersMoved: number;
}

const UNFOLLOW_CONCURRENCY = 8;

function isPermanentRefusal(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function errorStatus(error: unknown): number {
  const failure = error as { status?: unknown; response?: { status?: unknown } } | null;
  const status = failure?.status ?? failure?.response?.status;
  return typeof status === 'number' ? status : 0;
}

function errorCode(error: unknown): string {
  const failure = error as { code?: unknown; response?: { data?: { error?: unknown } } } | null;
  const code = failure?.code ?? failure?.response?.data?.error;
  return typeof code === 'string' && code.length > 0 ? code : 'unknown';
}

/**
 * Local accounts stop following the old actor.
 *
 * Oxy has already repointed each local follow of the old account to the target,
 * which is a local account, so no new remote Follow is owed. What is left here is
 * the outbound edge to the old actor: each one is undone through the normal
 * unfollow path (`sendUndoFollow` removes the `federated_follows` row and delivers
 * the `Undo(Follow)`). Usernames are resolved in one batched Oxy call. A row whose
 * user Oxy did not return is kept and counted, never dropped without its Undo.
 */
async function unfollowMovedActor(
  oldActorUri: string,
): Promise<{ unfollowed: number; unresolved: number }> {
  const follows = await findFollows({ remoteActorUri: oldActorUri, direction: 'outbound' });
  if (follows.length === 0) return { unfollowed: 0, unresolved: 0 };

  const users = await getServiceOxyClient().users.getMany(
    follows.map((follow) => follow.localUserId),
  );
  const usernames = new Map(
    users.flatMap((user) => (user?.id && user.username ? [[user.id, user.username] as const] : [])),
  );
  const resolved = follows.filter((follow) => usernames.has(follow.localUserId));

  const settled = await mapWithConcurrency(resolved, UNFOLLOW_CONCURRENCY, async (follow) => {
    await deliveryService.sendUndoFollow(
      follow.localUserId,
      usernames.get(follow.localUserId)!,
      oldActorUri,
    );
    // `sendUndoFollow` already removed the row unless federation is off or the
    // actor is not cached; either way the edge is stale now.
    await deleteFollow(follow.localUserId, oldActorUri, 'outbound');
  });
  const failed = settled.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  return { unfollowed: resolved.length, unresolved: follows.length - resolved.length };
}

function isOwnActorUri(uri: string): boolean {
  let host: string;
  try {
    host = new URL(uri).hostname.toLowerCase();
  } catch {
    return false;
  }
  return OWN_DOMAINS.some((own) => own.toLowerCase() === host);
}

/** Why {@link recordRemoteMove} did or did not record the move. */
export type RemoteMoveOutcome =
  | 'recorded'
  | 'local_target'
  | 'unknown_old_actor'
  | 'target_unresolved'
  | 'alias_missing';

/**
 * Remember a remote → remote move on the old actor's row.
 *
 * The same bilateral check Mastodon makes before it trusts a `Move`: the engine
 * has already verified that the OLD actor signed it, and the TARGET must list the
 * old actor in its `alsoKnownAs`, read fresh because an alias is usually added
 * moments before the move. Without that second half any account could announce
 * that it "moved" onto somebody else's profile.
 *
 * Only the move is recorded. Moving this server's follows to the new actor needs
 * Oxy, which owns the follow graph, and is not done here.
 */
export async function recordRemoteMove(move: InboundMove): Promise<RemoteMoveOutcome> {
  if (isOwnActorUri(move.targetActorUri)) return 'local_target';
  const oldActor = await findActorByUri(move.oldActorUri);
  if (!oldActor) return 'unknown_old_actor';
  const target = await actorService.fetchRemoteActor(move.targetActorUri);
  if (!target) return 'target_unresolved';
  if (!(target.alsoKnownAs ?? []).includes(move.oldActorUri)) return 'alias_missing';
  await setActorMovedTo(move.oldActorUri, target.uri);
  return 'recorded';
}

/** Forward a shape-verified Move to Oxy and, once Oxy applies it, adopt the old account here. */
export async function applyInboundMove(move: InboundMove): Promise<void> {
  const remote = await recordRemoteMove(move);
  if (remote !== 'local_target') {
    logger.info('[Federation] Remote move', {
      outcome: remote,
      activityId: move.activityId,
      oldActorUri: move.oldActorUri,
      targetActorUri: move.targetActorUri,
    });
  }

  let outcome: FederationMoveOutcome;
  try {
    outcome = await getServiceOxyClient().serviceRequest<FederationMoveOutcome>(
      'POST',
      '/federation/move',
      {
        oldActorUri: move.oldActorUri,
        targetActorUri: move.targetActorUri,
        activityId: move.activityId,
      },
    );
  } catch (error) {
    const status = errorStatus(error);
    if (!isPermanentRefusal(status)) throw error;
    logger.warn('[Federation] Move refused by Oxy', {
      code: errorCode(error),
      status,
      activityId: move.activityId,
      oldActorUri: move.oldActorUri,
      targetActorUri: move.targetActorUri,
    });
    return;
  }

  // The source-identity projection, not a parallel path: Oxy now resolves the
  // old actor to the target user, and this projects that one source's posts
  // (and their owner authorships) onto it. A later withdrawal in Oxy projects
  // them back the same way.
  const projection = await reconcileActorIdentityProjection({
    actorUri: move.oldActorUri,
    oxyUserId: outcome.targetUserId,
  });
  // Imports of the old account's posts collapse under the federated copies the
  // projection just made the user's (`docs/import.mdx`, "One post, not two").
  const collapsed = projection.refusal
    ? { clustered: 0 }
    : await collapseImportedCopies(
        { oxyUserId: outcome.targetUserId, actorUris: [move.oldActorUri] },
        { failOnError: true },
      );
  const follows = await unfollowMovedActor(move.oldActorUri);

  logger.info('[Federation] Move applied', {
    activityId: move.activityId,
    oldActorUri: move.oldActorUri,
    targetUserId: outcome.targetUserId,
    replayed: outcome.replayed,
    followersMoved: outcome.followersMoved,
    postsReattributed: projection.postsChanged,
    importsCollapsed: collapsed.clustered,
    oldActorUnfollowed: follows.unfollowed,
    ...(follows.unresolved > 0 ? { unfollowUnresolved: follows.unresolved } : {}),
    ...(projection.refusal ? { adoptionSkipped: projection.refusal } : {}),
  });
}
