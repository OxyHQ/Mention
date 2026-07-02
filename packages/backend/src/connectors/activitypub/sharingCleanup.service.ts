import { logger } from '../../utils/logger';
import FederatedActor from '../../models/FederatedActor';
import FederatedFollow from '../../models/FederatedFollow';
import { followService } from './follow.service';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { actorUrl, AP_CONTEXT } from './constants';

/**
 * Only returned when every inbound follower was fully torn down (bridged, or
 * never bridgeable). A partial failure never returns this shape — see
 * {@link runSharingCleanup}, which throws instead so the caller retries.
 */
export interface SharingCleanupResult {
  /** Inbound followers the Delete(actor) broadcast targeted. */
  deletesSent: number;
  /** Inbound followers successfully bridge-unfollowed on the Oxy graph. */
  followersRemoved: number;
}

/**
 * Runs when a user turns fediverse sharing OFF — tells the fediverse the actor
 * is gone and tears down the inbound follow edges.
 *
 * Order is load-bearing, not incidental:
 *  1. `followService.deliverToFollowers` reads the inbound `FederatedFollow`
 *     rows itself to resolve delivery inboxes — it MUST run before those rows
 *     are touched, or the Delete goes to nobody. Re-sending it on a retry is
 *     harmless: Delete(actor) is idempotent for a remote server (an actor
 *     that's already gone is a no-op to re-delete).
 *  2. A row is DELETABLE once its bridge-unfollow has succeeded, or it never
 *     had anything to bridge (no resolvable `FederatedActor.oxyUserId`) — this
 *     mirrors `inbox.service.ts`'s `handleIncomingFollow`/`handleUndo`, which
 *     both run their own bridge call BEFORE the matching local Mongo mutation
 *     for the same reason: a bridge failure must leave the row in place so a
 *     retry re-attempts it, never delete-then-hope.
 *  3. Only deletable rows are removed, ID-scoped (`_id: { $in: ... }`) so a
 *     row that arrives between the initial `find` and this delete (a fresh
 *     inbound Follow racing the toggle-off) is never swept up by accident.
 *  4. If any bridge call failed, THROW after the scoped delete — the caller
 *     (the BullMQ worker) lets this fail the job so it retries, and the
 *     failed rows are still present to retry against. A successful re-run
 *     converges: eventually every row is either bridged-and-deleted or was
 *     never bridgeable to begin with.
 */
export async function runSharingCleanup(
  oxyUserId: string,
  username: string,
): Promise<SharingCleanupResult> {
  const inboundFollows = await FederatedFollow.find({
    localUserId: oxyUserId,
    direction: 'inbound',
    status: 'accepted',
  }).lean();

  if (inboundFollows.length === 0) {
    return { deletesSent: 0, followersRemoved: 0 };
  }

  const actor = actorUrl(username);
  const nonce = Date.now().toString();
  const deleteActivity = {
    '@context': AP_CONTEXT,
    id: `${actor}#delete-${nonce}`,
    type: 'Delete',
    actor,
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    object: actor,
  };

  await followService.deliverToFollowers(deleteActivity, oxyUserId, username);

  const actorUris = inboundFollows.map((f) => f.remoteActorUri);
  const remoteActors = await FederatedActor.find({ uri: { $in: actorUris } })
    .select('uri oxyUserId')
    .lean();
  const followerOxyUserIdByActorUri = new Map(
    remoteActors
      .filter((a): a is typeof a & { oxyUserId: string } => Boolean(a.oxyUserId))
      .map((a) => [a.uri, a.oxyUserId]),
  );

  let followersRemoved = 0;
  let bridgeFailures = 0;
  const deletableIds: (typeof inboundFollows)[number]['_id'][] = [];

  for (const follow of inboundFollows) {
    const followerOxyUserId = followerOxyUserIdByActorUri.get(follow.remoteActorUri);

    if (!followerOxyUserId) {
      // Nothing to bridge for this row — safe to delete regardless.
      deletableIds.push(follow._id);
      continue;
    }

    try {
      await getServiceOxyClient().makeServiceRequest('POST', '/federation/follow', {
        followerUserId: followerOxyUserId,
        targetUserId: oxyUserId,
        action: 'unfollow',
      });
      followersRemoved += 1;
      deletableIds.push(follow._id);
    } catch (err) {
      bridgeFailures += 1;
      logger.warn(
        `[SharingCleanup] bridge-unfollow failed for follower ${followerOxyUserId} of ${oxyUserId}:`,
        err,
      );
    }
  }

  if (deletableIds.length > 0) {
    await FederatedFollow.deleteMany({ _id: { $in: deletableIds } });
  }

  if (bridgeFailures > 0) {
    throw new Error(
      `[SharingCleanup] ${bridgeFailures} of ${inboundFollows.length} bridge-unfollow call(s) failed for ${oxyUserId} — job will retry against the remaining rows`,
    );
  }

  return { deletesSent: inboundFollows.length, followersRemoved };
}
