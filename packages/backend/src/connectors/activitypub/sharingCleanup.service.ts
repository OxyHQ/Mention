import { logger } from '../../utils/logger';
import FederatedActor from '../../models/FederatedActor';
import FederatedFollow from '../../models/FederatedFollow';
import { followService } from './follow.service';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { actorUrl, AP_CONTEXT } from './constants';

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
 *     are touched, or the Delete goes to nobody.
 *  2. Bridge-unfollowing the Oxy graph is best-effort per follower (a remote
 *     actor that never resolved to an Oxy user is skipped, and a transient
 *     bridge failure is logged and does not abort the run).
 *  3. The local `FederatedFollow` rows are deleted LAST, and unconditionally —
 *     sharing is off regardless of whether every bridge call succeeded, so
 *     stale local follow rows must not survive this run.
 *
 * Idempotent: deleting the rows in step 3 is what makes a re-run (queue retry,
 * or the inline fallback racing an already-enqueued job) converge — a second
 * call finds zero inbound rows and is a pure no-op.
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
  for (const follow of inboundFollows) {
    const followerOxyUserId = followerOxyUserIdByActorUri.get(follow.remoteActorUri);
    if (!followerOxyUserId) continue;

    try {
      await getServiceOxyClient().makeServiceRequest('POST', '/federation/follow', {
        followerUserId: followerOxyUserId,
        targetUserId: oxyUserId,
        action: 'unfollow',
      });
      followersRemoved += 1;
    } catch (err) {
      logger.warn(
        `[SharingCleanup] bridge-unfollow failed for follower ${followerOxyUserId} of ${oxyUserId}:`,
        err,
      );
    }
  }

  await FederatedFollow.deleteMany({
    localUserId: oxyUserId,
    direction: 'inbound',
    status: 'accepted',
  });

  return { deletesSent: inboundFollows.length, followersRemoved };
}
