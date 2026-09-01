/**
 * TELLING THE FEDIVERSE — the Tombstones for a batch, and the actor `Delete`.
 *
 * Ordering against the rest of the cascade is the whole content of this module:
 * a batch's Tombstones go out BEFORE its rows are deleted, and the actor
 * `Delete` goes out before the `federated_follows` rows delivery resolves its
 * inboxes from.
 */

import { PostVisibility } from '@mention/shared-types';
import { followService } from '../../connectors/activitypub/follow.service';
import { deliveryService } from '../../connectors/activitypub/delivery.service';
import { actorUrl } from '../../connectors/activitypub/constants';
import { AP_CONTEXT } from '@oxyhq/federation';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { LOG_PREFIX } from './channelCascadeLog';
import type { PostBatch } from './channelDeletionTargets';

/**
 * The channel's username, resolved SERVER-SIDE from the authoritative
 * `oxyUserId` — the canonical Note ids a remote server matches against are minted
 * from it, and no request-scoped value is trusted for it.
 *
 * A resolve miss THROWS before any row is deleted, so the run is retried rather
 * than leaving remote copies with no local post left to address a later Delete
 * from. Resolved ONCE per run and reused by every batch's Tombstones.
 */
export async function resolveChannelUsername(channelOxyUserId: string): Promise<string> {
  const user = await getServiceOxyClient().getUserById(channelOxyUserId);
  const username = user.username?.trim();
  if (!username) {
    throw new Error(
      `${LOG_PREFIX} cannot federate the deletion of ${channelOxyUserId}: no resolvable username`,
    );
  }
  return username;
}

/**
 * Per-post Tombstones for one batch, sent BEFORE its rows are deleted.
 *
 * Once the actor is deleted a remote server may drop the account wholesale, and
 * an instance that does not still needs each status named. `federateDelete` is
 * best-effort by design and never throws.
 *
 * Only PUBLIC + PUBLISHED posts: a draft, a scheduled post, a followers-only post
 * or one `restricted` by moderation was never advertised, so a Tombstone for it
 * would name an object the receiving instance has never heard of.
 */
export async function broadcastBatchTombstones(
  batch: PostBatch,
  channelOxyUserId: string,
  username: string,
): Promise<void> {
  for (const post of batch.channelPosts) {
    if (post.visibility !== PostVisibility.PUBLIC || post.status !== 'published') continue;
    await followService.federateDelete({ id: post.id }, channelOxyUserId, username);
  }
}

/**
 * Tell the fediverse the actor is gone, BEFORE anything the delivery path reads
 * is deleted: `deliverToFollowers` resolves its inboxes from the
 * `federated_follows` rows, which the account phase removes.
 */
export async function broadcastActorDelete(
  channelOxyUserId: string,
  username: string,
): Promise<void> {
  const actor = actorUrl(username);
  await deliveryService.deliverToFollowers(
    {
      '@context': AP_CONTEXT,
      id: `${actor}#delete-${Date.now()}`,
      type: 'Delete',
      actor,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      object: actor,
    },
    channelOxyUserId,
    username,
  );
}
