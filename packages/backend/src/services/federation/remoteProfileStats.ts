import type { RemoteProfileStats } from '@mention/shared-types/profile';
import type { FederatedActorRecord } from '../../db/federation/actorRecord';
import { findActorByOxyUserId } from '../../db/federation/actorRepository';

/**
 * The origin figures for the account behind `oxyUserId`, or `undefined` for a
 * local account — one with no cached actor row, which costs one indexed miss.
 */
export async function loadRemoteProfileStats(oxyUserId: string): Promise<RemoteProfileStats | undefined> {
  const actor = await findActorByOxyUserId(oxyUserId);
  return actor ? remoteProfileStats(actor) : undefined;
}

/**
 * A remote account's own numbers, as the profile page may show them.
 *
 * A federated profile is an Oxy account MINTED the day Mention first resolved the
 * actor, so its Oxy `createdAt` is our discovery date and its Oxy follow graph
 * holds only the follows made through this server. Rendering either as the
 * account's "Joined" date or its follower total is wrong for every established
 * remote account. The origin's figures are already persisted on the actor row —
 * the resolver reads the `followers`/`following` collections' `totalItems` and
 * the actor's `published` on every refresh — and this maps that row to what the
 * page may claim.
 *
 * UNKNOWN is omitted rather than defaulted, because the columns cannot say
 * "unknown" themselves (`not null default 0`):
 *
 * - A row never fetched holds only schema defaults.
 * - An ActivityPub actor that publishes no `followers`/`following` collection
 *   has no total to report; the resolver stores `0` for it all the same.
 *
 * What remains indistinguishable is an actor whose collection fetch FAILED:
 * `@oxy.so/federation` collapses that to `0` too, before the store ever sees it.
 */
export function remoteProfileStats(actor: FederatedActorRecord): RemoteProfileStats {
  const stats: RemoteProfileStats = {};
  if (actor.lastFetchedAt) {
    // An atproto profile reports both counts on every fetch; it has no
    // collection URLs to gate on.
    const isActivityPub = actor.protocol === 'activitypub';
    if (!isActivityPub || actor.followersUrl) stats.followersCount = actor.followersCount;
    if (!isActivityPub || actor.followingUrl) stats.followingCount = actor.followingCount;
  }
  const joinedAt = trustedRemoteCreatedAt(actor.remoteCreatedAt);
  if (joinedAt) stats.joinedAt = joinedAt.toISOString();
  return stats;
}

/**
 * The actor's `published` date, when it can be one.
 *
 * The resolver parses `published` with a bare `new Date(...)`, so an unparseable
 * value arrives as an Invalid Date — which the column write cannot serialize, and
 * which would fail the whole actor refresh over a cosmetic field. An account
 * cannot have been created after now either. Both read as unknown.
 */
export function trustedRemoteCreatedAt(value: Date | undefined, now = Date.now()): Date | undefined {
  if (!(value instanceof Date)) return undefined;
  const ms = value.getTime();
  if (Number.isNaN(ms) || ms > now) return undefined;
  return value;
}
