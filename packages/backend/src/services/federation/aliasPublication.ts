/**
 * Tell remote servers promptly when a local account's `alsoKnownAs` changes.
 *
 * A Mastodon user moving TO Mention links the old account in Oxy; Oxy then
 * publishes it as the Mention actor's `alsoKnownAs`. Mastodon refuses the Move
 * unless the target actor ALREADY lists the old account, so the alias has to
 * reach remote caches before the user presses Move — not whenever their copy of
 * our actor next goes stale.
 *
 * The trigger is Oxy's `oxy:user:invalidate` `profile` event, which Oxy publishes
 * when a linked-account alias is added or removed (and on every other profile
 * change). The event carries only a user id, so each one is checked here:
 *
 *  1. one task per event — every task receives every event, so a Redis `NX`
 *     claim on `(user, event time)` lets exactly one of them do the rest;
 *  2. local accounts only — one with an ActivityPub key pair, the thing that
 *     signs its actor. A federated mirror has none; a local account that never
 *     federated has no remote copy to refresh;
 *  3. re-read the profile from Oxy (the invalidation handler has already swept
 *     the SDK cache) and compare its `alsoKnownAs` with the last set announced,
 *     swapped atomically (`SET … GET`);
 *  4. only on a real change, raise the existing `actor.update` event, which
 *     rebroadcasts the full actor as an `Update(Person)` to the account's
 *     followers through the normal connector seam (fediverse-sharing gate
 *     included).
 *
 * Inert without Redis, and never throws into the subscriber: a missed event only
 * leaves remote servers on their own actor refresh, as before.
 */

import { normalizeAlsoKnownAs } from '@oxy.so/federation';
import { getRedisClient } from '../../utils/redis';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { logger } from '../../utils/logger';
import { hasActorKeyPair } from '../../db/federation/actorKeyPairRepository';

const CLAIM_TTL_SECONDS = 300;
/** The announced set expires eventually; a lost snapshot costs one redundant Update. */
const SNAPSHOT_TTL_SECONDS = 90 * 24 * 60 * 60;

const claimKey = (userId: string, at: number) => `ap:alias-check:${userId}:${at}`;
const snapshotKey = (userId: string) => `ap:also-known-as:${userId}`;

export type AliasPublicationOutcome =
  | 'not_local'
  | 'no_redis'
  | 'claimed_elsewhere'
  | 'no_username'
  | 'unchanged'
  | 'published'
  | 'failed';

/**
 * The aliases as published — the federation package's own rule
 * (`normalizeAlsoKnownAs`, the one the actor builder applies), compared as a
 * set, so a value the actor builder would drop never counts as a change.
 */
export function aliasFingerprint(values: readonly string[] | null | undefined): string {
  return JSON.stringify(normalizeAlsoKnownAs(values).sort());
}

/** Handle one Oxy `profile` invalidation. Never throws. */
export async function publishAliasChange(event: { userId: string; at: number }): Promise<AliasPublicationOutcome> {
  try {
    return await checkAndPublish(event);
  } catch (error) {
    logger.warn('[AliasPublication] alias check failed', {
      userId: event.userId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return 'failed';
  }
}

async function checkAndPublish(event: { userId: string; at: number }): Promise<AliasPublicationOutcome> {
  const redis = getRedisClient();
  if (!redis.isReady) return 'no_redis';
  const claimed = await redis.set(claimKey(event.userId, event.at), '1', { NX: true, EX: CLAIM_TTL_SECONDS });
  if (claimed !== 'OK') return 'claimed_elsewhere';
  if (!(await hasActorKeyPair(event.userId))) return 'not_local';

  const oxy = getServiceOxyClient();
  const username = (await oxy.getUserById(event.userId)).username?.trim();
  if (!username) return 'no_username';
  // `GET /profiles/username/:username` is the read that carries `alsoKnownAs`,
  // and the same one the actor route and the Update builder use.
  const profile = await oxy.getProfileByUsername(username);
  const current = aliasFingerprint(profile?.alsoKnownAs);

  const previous = await redis.set(snapshotKey(event.userId), current, { GET: true, EX: SNAPSHOT_TTL_SECONDS });
  const empty = aliasFingerprint([]);
  if (previous === current || (previous === null && current === empty)) return 'unchanged';

  try {
    // Lazy: the connector registry reaches the server singleton, and this module
    // is loaded by the subscriber at boot.
    const { federateAsResolvedActorAndWait } = await import('../../connectors/outboundFederation.js');
    await federateAsResolvedActorAndWait(
      event.userId,
      'actor alias update',
      (actorUsername) => ({ kind: 'actor.update', actorOxyUserId: event.userId, actorUsername }),
      false,
    );
  } catch (error) {
    // Put the old snapshot back so the next event for this user tries again.
    if (previous === null) await redis.del(snapshotKey(event.userId));
    else await redis.set(snapshotKey(event.userId), previous, { EX: SNAPSHOT_TTL_SECONDS });
    throw error;
  }
  logger.info('[AliasPublication] alsoKnownAs changed; actor Update sent', { userId: event.userId });
  return 'published';
}
