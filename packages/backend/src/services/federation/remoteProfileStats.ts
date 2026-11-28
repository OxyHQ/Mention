import type { RemoteProfileField, RemoteProfileStats } from '@mention/shared-types/profile';
import type { FederatedActorField, FederatedActorRecord } from '../../db/federation/actorRecord';
import {
  findActorByOxyUserId,
  findActorByUri,
  loadActorFields,
} from '../../db/federation/actorRepository';
import { htmlToInlineLabel } from '../../utils/federation/htmlToPlainText';

/**
 * The origin figures for the account behind `oxyUserId`, or `undefined` for a
 * local account — one with no cached actor row, which costs one indexed miss.
 * Its metadata table is one more indexed read beside it, and a moved account's
 * new handle another.
 */
export async function loadRemoteProfileStats(
  oxyUserId: string,
): Promise<RemoteProfileStats | undefined> {
  const actor = await findActorByOxyUserId(oxyUserId);
  if (!actor) return undefined;
  const [fields, target] = await Promise.all([
    loadActorFields(actor.id),
    // `recordRemoteMove` resolved the target before writing, so its row exists;
    // a target purged since then simply leaves the move unstated.
    actor.movedTo ? findActorByUri(actor.movedTo) : null,
  ]);
  const stats = remoteProfileStats(actor, fields);
  if (target) stats.movedTo = { handle: target.acct, actorUri: target.uri };
  return stats;
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
 * UNKNOWN is omitted rather than defaulted — the page shows no figure instead
 * of a fabricated "0 followers":
 *
 * - A `null` count: the remote hid the collection (401/403), it is gone, it
 *   carries no `totalItems`, or no fetch of it has ever succeeded. Since
 *   `@oxy.so/federation` 2.0 a failed read is never stored as `0`, and a failed
 *   REFRESH leaves the last known figure in place.
 * - A row never fetched, whose values are nothing the remote said.
 * - An ActivityPub actor that publishes no `followers`/`following` collection
 *   (rows written before the columns became nullable hold `0` for it).
 */
export function remoteProfileStats(
  actor: FederatedActorRecord,
  fields: readonly FederatedActorField[] = [],
): RemoteProfileStats {
  const stats: RemoteProfileStats = {};
  if (actor.lastFetchedAt) {
    // An atproto profile reports every count on every fetch; it has no
    // collection URLs to gate on.
    const isActivityPub = actor.protocol === 'activitypub';
    if ((!isActivityPub || actor.followersUrl) && actor.followersCount !== null) {
      stats.followersCount = actor.followersCount;
    }
    if ((!isActivityPub || actor.followingUrl) && actor.followingCount !== null) {
      stats.followingCount = actor.followingCount;
    }
    if ((!isActivityPub || actor.outboxUrl) && actor.postsCount !== null) {
      stats.postsCount = actor.postsCount;
    }
  }
  const joinedAt = trustedRemoteCreatedAt(actor.remoteCreatedAt);
  if (joinedAt) stats.joinedAt = joinedAt.toISOString();
  if (actor.manuallyApprovesFollowers) stats.locked = true;
  if (actor.memorial) stats.memorial = true;
  const shown = fields.flatMap(remoteProfileField);
  if (shown.length > 0) stats.fields = shown;
  return stats;
}

/**
 * A stored metadata row as the page shows it. The ingest kept only `a`/`span`
 * markup in the value; this reduces it to text with the converter a remote bio
 * goes through, so a link becomes its URL (re-linked by the client) and no
 * remote markup reaches a renderer. A row left with no name or value is dropped.
 */
function remoteProfileField(field: FederatedActorField): RemoteProfileField[] {
  const name = htmlToInlineLabel(field.name);
  const value = htmlToInlineLabel(field.value);
  if (!name || !value) return [];
  return [{ name, value, ...(field.verifiedAt && { verifiedAt: field.verifiedAt.toISOString() }) }];
}

/**
 * No account on a network Mention federates with predates this; an earlier
 * date is a placeholder (the Unix epoch, year 1) rather than a join date.
 */
const EARLIEST_ACCOUNT_MS = Date.UTC(2000, 0, 1);

/**
 * The account's creation date (AP `published`, atproto `createdAt`), when it can be one.
 *
 * The resolver parses `published` with a bare `new Date(...)`, so an unparseable
 * value arrives as an Invalid Date — which the column write cannot serialize, and
 * which would fail the whole actor refresh over a cosmetic field. An account
 * cannot have been created after now, or before {@link EARLIEST_ACCOUNT_MS},
 * either. All three read as unknown.
 */
export function trustedRemoteCreatedAt(
  value: Date | undefined,
  now = Date.now(),
): Date | undefined {
  if (!(value instanceof Date)) return undefined;
  const ms = value.getTime();
  if (Number.isNaN(ms) || ms > now || ms < EARLIEST_ACCOUNT_MS) return undefined;
  return value;
}
