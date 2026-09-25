/**
 * TELLING THE FEDIVERSE an account is gone: a `Delete(Tombstone)` for each post
 * that was federated, then a `Delete` of the actor.
 *
 * Both go through the normal outbound path, `deliveryService.deliverToFollowers`:
 * one durable job per follower inbox, signed by Oxy on Mention's behalf
 * (`POST /federation/sign`) and retried on the delivery queue's own schedule. Two
 * facts make that work after Oxy has deleted the account:
 *
 *  - The signing key survives. Oxy keeps `federation_key_pairs` (keyed by the
 *    actor's key id, not by the user row), so a Delete can still be signed for an
 *    account whose user row is gone.
 *  - The HANDLE survives, in `account_erasures.username`. Actor and Note ids are
 *    minted from it, and Oxy no longer resolves it. The delivery worker falls back
 *    to the ledger when Oxy cannot name a sender (`queue/workers.ts`).
 *
 * Without a handle nothing can be addressed, so nothing is sent and the local
 * erasure still runs. The ledger records that the broadcast was skipped.
 *
 * Remote servers are ASKED, not forced. A server may ignore a Delete, and one that
 * stays down past the delivery retry budget (about 63 hours) never hears it.
 */

import { AP_CONTEXT } from '@oxy.so/federation';
import { followService } from '../../connectors/activitypub/follow.service';
import { deliveryService } from '../../connectors/activitypub/delivery.service';
import { FEDERATION_ENABLED, actorUrl } from '../../connectors/activitypub/constants';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { federatedFollows } from '../../db/schema/federation';
import type { OwnPostRow } from './erasePosts';

const AP_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

/**
 * The actor `Delete`. Its id is DETERMINISTIC (no timestamp), so a re-run
 * re-sends the same activity and the delivery queue dedupes it per inbox instead
 * of fanning out a second copy.
 */
export function buildActorDeleteActivity(username: string): Record<string, unknown> {
  const actor = actorUrl(username);
  return {
    '@context': AP_CONTEXT,
    id: `${actor}#delete`,
    type: 'Delete',
    actor,
    to: [AP_PUBLIC],
    object: actor,
  };
}

/** Does any remote actor still follow the account? The Delete's only recipients. */
async function hasRemoteFollowers(oxyUserId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: federatedFollows.id })
    .from(federatedFollows)
    .where(
      and(
        eq(federatedFollows.localUserId, oxyUserId),
        eq(federatedFollows.direction, 'inbound'),
        eq(federatedFollows.status, 'accepted'),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Delete(Tombstone) for each federated post in a batch. Returns how many were
 * handed to delivery: none when nobody remote follows the account, since the
 * followers are the only inboxes a Delete is addressed to.
 */
export async function broadcastPostDeletes(
  oxyUserId: string,
  username: string,
  batch: readonly OwnPostRow[],
): Promise<number> {
  if (!FEDERATION_ENABLED || batch.length === 0) return 0;
  if (!(await hasRemoteFollowers(oxyUserId))) return 0;
  for (const post of batch) {
    const activity = followService.buildDeleteActivity(username, post.id);
    await deliveryService.deliverToFollowers(activity, oxyUserId, username);
  }
  return batch.length;
}

/**
 * The actor Delete, sent while the `federated_follows` rows delivery resolves its
 * inboxes from still exist. Returns whether it was handed to delivery: false when
 * nobody remote follows the account (nothing to address), which is also what a
 * re-run after a completed erasure sees.
 */
export async function broadcastActorDelete(oxyUserId: string, username: string): Promise<boolean> {
  if (!FEDERATION_ENABLED) return false;
  if (!(await hasRemoteFollowers(oxyUserId))) return false;
  await deliveryService.deliverToFollowers(buildActorDeleteActivity(username), oxyUserId, username);
  return true;
}
