import { createHash } from 'node:crypto';
import { AP_CONTEXT } from '@oxy.so/federation';
import { ownProfileUrlHandle } from '@mention/shared-types/profileUrls';
import { logger } from '../../utils/logger';
import { isFediverseSharingEnabled } from '../../services/fediverseSharing';
import { resolveMentionCommunities } from '../../services/publishAsAccount';
import { resolveUserSummaries } from '../../services/PostHydrationService';
import { loadPostRecord } from '../../db/posts/postRepository';
import { findActorsByOxyUserIds } from '../../db/federation/actorRepository';
import { isAbsoluteHttpUrl } from '../shared/url';
import { actorUrl, followersUrl, resolveOxyUser } from './constants';
import { deliveryService } from './delivery.service';
import { asRecord, extractActorUri, sameOrigin } from './helpers';
import { OWN_DOMAINS } from './ownDomain';

/**
 * A community HOSTED HERE relaying its members (FEP-1b12) — the outbound half of
 * what `apRelay.ts` reads inbound.
 *
 * A community is a forwarding actor: a member addresses an activity to it, and
 * it re-sends that activity to its own followers wrapped in an `Announce` it
 * signs — `Announce { Create { Note | Page } }` for a post or a comment, and the
 * same for its `Update` and `Delete`. Lemmy, PieFed and Mbin show a community's
 * posts only through those Announces; without them a community followed from
 * there stays empty forever.
 *
 * For a member writing HERE there is no inbox round trip: the post is stored with
 * its community, and the community relays the member's own `Create` straight
 * after the member's followers get it. A REMOTE member's activity is relayed once
 * the inbox has stored it — and only when it is self-consistent (see
 * {@link isSelfConsistentActivity}), because the Announce is the community
 * vouching for it.
 */

const AP_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

/** A community hosted here, as the fediverse addresses it. */
export interface LocalCommunityActor {
  oxyUserId: string;
  username: string;
  actorUri: string;
}

/** The community hosted here behind an Oxy id, as an actor, or null. */
export async function resolveLocalCommunityActor(
  oxyUserId: string | null | undefined,
): Promise<LocalCommunityActor | null> {
  if (!oxyUserId) return null;
  return (await resolveLocalCommunityActors([oxyUserId])).get(oxyUserId) ?? null;
}

/** {@link resolveLocalCommunityActor} for several ids, one batched identity read. */
export async function resolveLocalCommunityActors(
  oxyUserIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, LocalCommunityActor>> {
  const actors = new Map<string, LocalCommunityActor>();
  for (const [oxyUserId, community] of await resolveMentionCommunities(oxyUserIds)) {
    const username = community.username?.trim();
    if (username) actors.set(oxyUserId, { oxyUserId, username, actorUri: actorUrl(username) });
  }
  return actors;
}

/** Addressees of an AP addressing field, bounded so a hostile object costs little. */
function addressees(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list
    .filter((entry): entry is string => typeof entry === 'string' && isAbsoluteHttpUrl(entry))
    .slice(0, 10);
}

/**
 * The community hosted here that an inbound object is addressed to — its
 * `audience` (Lemmy since 0.18, PieFed, Mbin) or a `to`/`cc` addressee (older
 * Lemmy) that is one of OUR actors and a community — or null.
 *
 * Unlike a remote community, a local one needs no vouching: it is the authority
 * on what is posted in it, and posting in it is open to anybody it has not
 * banned (`postingRestrictedToMods: false`).
 */
export async function addressedLocalCommunity(
  object: Record<string, unknown>,
): Promise<LocalCommunityActor | null> {
  const candidates = [
    ...new Set([
      ...addressees(object.audience),
      ...addressees(object.to),
      ...addressees(object.cc),
    ]),
  ];
  for (const uri of candidates) {
    const handle = ownProfileUrlHandle(uri, OWN_DOMAINS);
    if (!handle) continue;
    const user = await resolveOxyUser(handle);
    const id = user ? String(user.id || user._id || '') : '';
    const community = id ? await resolveLocalCommunityActor(id) : null;
    if (community) return community;
  }
  return null;
}

/**
 * Whether a remote activity speaks only for its own actor: the activity and the
 * object it carries share the actor's origin, and the object is attributed to
 * that actor. The inbox has already verified that the actor signed the delivery;
 * this is the other half — a community must never relay a post its sender
 * claims somebody else wrote.
 */
export function isSelfConsistentActivity(
  activity: Record<string, unknown>,
  actorUri: string,
): boolean {
  const id = typeof activity.id === 'string' ? activity.id : '';
  if (!id || !sameOrigin(id, actorUri)) return false;
  const object = asRecord(activity.object);
  if (!object) return typeof activity.object === 'string' && sameOrigin(activity.object, actorUri);
  if (typeof object.id !== 'string' || !sameOrigin(object.id, actorUri)) return false;
  const attributedTo = extractActorUri(object.attributedTo);
  return attributedTo === undefined || attributedTo === actorUri;
}

/**
 * The `Announce` a community wraps a member's activity in. Its id is derived from
 * the relayed activity's, so a retried relay dedupes per inbox exactly like the
 * activity itself; the embedded activity drops its own `@context`, which the
 * envelope carries.
 */
export function buildCommunityAnnounce(
  community: LocalCommunityActor,
  activity: Record<string, unknown>,
): Record<string, unknown> {
  const { '@context': _context, ...relayed } = activity;
  const digest = createHash('sha256')
    .update(String(activity.id ?? ''))
    .digest('hex')
    .slice(0, 32);
  return {
    '@context': AP_CONTEXT,
    id: `${community.actorUri}/relays/${digest}`,
    type: 'Announce',
    actor: community.actorUri,
    to: [AP_PUBLIC],
    cc: [followersUrl(community.username)],
    object: relayed,
  };
}

/**
 * Relay a member's activity to the community's fediverse followers. Best-effort,
 * like every outbound delivery: a failure is logged and never undoes the post.
 */
export async function relayToCommunityFollowers(
  community: LocalCommunityActor,
  activity: Record<string, unknown>,
): Promise<void> {
  try {
    if (!(await isFediverseSharingEnabled(community.oxyUserId))) return;
    await deliveryService.deliverToFollowers(
      buildCommunityAnnounce(community, activity),
      community.oxyUserId,
      community.username,
    );
  } catch (err) {
    logger.error('[Federation] failed to relay a community activity', err);
  }
}

/**
 * A `Delete` reduced to its reference — what a community relays of a REMOTE
 * member's deletion. The member's own activity can carry anything its server
 * likes (a Linked Data signature, an `atomUri`); a community vouches for the
 * retraction, not for those bytes.
 */
export function referenceOnlyDelete(
  activity: Record<string, unknown>,
  actorUri: string,
  objectId: string,
): Record<string, unknown> {
  return {
    id: String(activity.id),
    type: 'Delete',
    actor: actorUri,
    to: [AP_PUBLIC],
    object: objectId,
  };
}

/**
 * The `Delete` a MODERATOR sends to remove a post from the community (Lemmy's
 * removal: a `Delete` whose actor is a moderator rather than the author, with the
 * reason as `summary`), relayed by the community like any member activity.
 */
export function buildCommunityRemoval(
  community: LocalCommunityActor,
  moderatorActorUri: string,
  objectId: string,
  reason: string | null,
): Record<string, unknown> {
  return {
    id: `${community.actorUri}/removals/${Date.now()}`,
    type: 'Delete',
    actor: moderatorActorUri,
    to: [AP_PUBLIC],
    cc: [community.actorUri],
    audience: community.actorUri,
    object: objectId,
    ...(reason ? { summary: reason } : {}),
  };
}

/**
 * The `Block` a community sends a person it bans (Mastodon unfollows and stops
 * offering the community to them; Lemmy reads a community ban the same way), and
 * the `Undo` that lifts it. Ids are derived from the pair, so a re-ban
 * re-delivers the same activity.
 */
export function buildCommunityBlock(
  community: LocalCommunityActor,
  bannedActorUri: string,
  reason: string | null,
): Record<string, unknown> {
  const digest = createHash('sha256').update(bannedActorUri).digest('hex').slice(0, 32);
  return {
    '@context': AP_CONTEXT,
    id: `${community.actorUri}/bans/${digest}`,
    type: 'Block',
    actor: community.actorUri,
    object: bannedActorUri,
    target: community.actorUri,
    ...(reason ? { summary: reason } : {}),
  };
}

export function buildCommunityUnblock(
  community: LocalCommunityActor,
  bannedActorUri: string,
): Record<string, unknown> {
  const block = buildCommunityBlock(community, bannedActorUri, null);
  return {
    '@context': AP_CONTEXT,
    id: `${String(block.id)}/undo/${Date.now()}`,
    type: 'Undo',
    actor: community.actorUri,
    // The reference Mastodon matches the block it undoes by: id, actor, object.
    object: { id: block.id, type: 'Block', actor: community.actorUri, object: bannedActorUri },
  };
}

/**
 * The AP object id a post is known by on the fediverse: a local post's minted
 * Note id, a federated one's own. Null when there is nothing to name.
 */
export async function communityPostObjectId(postId: string): Promise<string | null> {
  const post = await loadPostRecord(postId);
  if (!post) return null;
  if (post.federation) return post.federation.activityId ?? null;
  const author = post.oxyUserId
    ? (await resolveUserSummaries([post.oxyUserId])).get(post.oxyUserId)?.user.username
    : undefined;
  return author ? `${actorUrl(author)}/posts/${post.id}` : null;
}

/**
 * Federate a moderator's removal of a post from a community hosted here: the
 * moderator's `Delete` (Lemmy's removal), relayed by the community. Sent only
 * when the moderator federates — the removal names their actor, which a
 * receiver dereferences — and best-effort, like every relay.
 */
export async function federateCommunityRemoval(params: {
  communityOxyUserId: string;
  moderatorOxyUserId: string;
  objectId: string;
  reason: string | null;
}): Promise<void> {
  const [community, sharing, summaries] = await Promise.all([
    resolveLocalCommunityActor(params.communityOxyUserId),
    isFediverseSharingEnabled(params.moderatorOxyUserId),
    resolveUserSummaries([params.moderatorOxyUserId]),
  ]);
  const moderator = summaries.get(params.moderatorOxyUserId)?.user.username?.trim();
  if (!community || !sharing || !moderator) return;
  await relayToCommunityFollowers(
    community,
    buildCommunityRemoval(community, actorUrl(moderator), params.objectId, params.reason),
  );
}

/**
 * Deliver a community's `Block` (or the `Undo` lifting it) to the person it
 * concerns, when they are a remote account. A local person needs no message:
 * the ban is enforced here.
 */
async function deliverToBannedPerson(
  communityOxyUserId: string,
  bannedOxyUserId: string,
  build: (community: LocalCommunityActor, bannedActorUri: string) => Record<string, unknown>,
): Promise<void> {
  try {
    const [community, [actor]] = await Promise.all([
      resolveLocalCommunityActor(communityOxyUserId),
      findActorsByOxyUserIds([bannedOxyUserId]),
    ]);
    const inbox = actor?.sharedInboxUrl || actor?.inboxUrl;
    if (!community || !actor?.uri || !inbox) return;
    if (!(await isFediverseSharingEnabled(community.oxyUserId))) return;
    await deliveryService.queueDelivery(build(community, actor.uri), inbox, community.oxyUserId);
  } catch (err) {
    logger.error('[Federation] failed to federate a community ban', err);
  }
}

/** Federate a ban: the community `Block`s the banned remote account. */
export function federateCommunityBan(
  communityOxyUserId: string,
  bannedOxyUserId: string,
  reason: string | null,
): Promise<void> {
  return deliverToBannedPerson(communityOxyUserId, bannedOxyUserId, (community, actorUri) =>
    buildCommunityBlock(community, actorUri, reason),
  );
}

/** Federate a lifted ban: the community's `Undo(Block)`. */
export function federateCommunityUnban(
  communityOxyUserId: string,
  bannedOxyUserId: string,
): Promise<void> {
  return deliverToBannedPerson(communityOxyUserId, bannedOxyUserId, (community, actorUri) =>
    buildCommunityUnblock(community, actorUri),
  );
}
