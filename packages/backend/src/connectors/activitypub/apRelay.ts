import { extractLocalPostIdFromApUri } from './constants';
import {
  asRecord,
  extractActorUri,
  extractAnnouncedObjectUri,
  fetchFromOrigin,
  sameOrigin,
} from './helpers';
import { primaryApType } from './apSchemas';
import { isAbsoluteHttpUrl } from '../shared/url';

/**
 * An `Announce` whose object is an ACTIVITY — how a community relays its members.
 *
 * A Lemmy/PieFed/Mbin community (an ActivityPub `Group`, FEP-1b12) does not
 * boost posts. Every activity a member addresses to it — the `Create` of a post
 * or a comment, its `Update`, its `Delete`, every vote — comes back to the
 * community's followers wrapped in an `Announce` signed by the COMMUNITY:
 *
 *   Announce { actor: <community>, object: Create { actor: <member>, object: Page } }
 *
 * Read as a boost, that is a boost of a `Create`, which is not a post, so every
 * community post was dropped. The inner activity is what was meant to arrive, so
 * it is processed as if its own actor had delivered it — the post is the
 * member's, never the community's boost — once it is verified.
 *
 * This module is the ONE place an `Announce` is read: the inbox and the outbox
 * backfill both ask {@link resolveAnnouncedActivity} whether they hold a boost or
 * a relayed activity, so the two roads cannot disagree about the same object.
 */

/** What an `Announce` turned out to carry. */
export type AnnouncedActivity =
  /** An ordinary boost of the object at `objectUri`. */
  | { kind: 'object'; objectUri: string }
  /**
   * A relayed activity, VERIFIED: `activity` is either the embedded one, when its
   * origin is the relaying actor's, or the copy fetched from its own origin.
   * `actorUri` is the actor it is processed as — the member, not the community.
   */
  | { kind: 'activity'; activity: Record<string, unknown>; actorUri: string }
  /** Nothing to process; `reason` says why, for the log. */
  | { kind: 'dropped'; reason: string };

/**
 * The AS2 activity types (plus Lemmy's `Lock`). An `Announce` whose embedded
 * object has one of these types relays that activity; any other embedded object
 * is a boost of it.
 */
const ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  'Accept',
  'Add',
  'Announce',
  'Arrive',
  'Block',
  'Create',
  'Delete',
  'Dislike',
  'Flag',
  'Follow',
  'Ignore',
  'Invite',
  'Join',
  'Leave',
  'Like',
  'Listen',
  'Lock',
  'Move',
  'Offer',
  'Read',
  'Reject',
  'Remove',
  'TentativeAccept',
  'TentativeReject',
  'Travel',
  'Undo',
  'Update',
  'View',
]);

/**
 * The relayed activities the inbox has a counterpart for. Everything else a
 * community relays is DROPPED here, before anything is fetched:
 *
 * - `Dislike` and `Undo(Dislike)`: Mention takes no downvote from the fediverse.
 * - `Lock`, `Add`/`Remove` (moderators, featured posts), `Block` (community
 *   bans), `Flag`: community moderation, which Mention does not model.
 * - A nested `Announce`: one level of relay is the protocol; more is a loop.
 *
 * `Like` and `Undo(Like)` are kept only when they concern a LOCAL post — see
 * {@link unprocessedReason}.
 */
export const INBOX_RELAYED_TYPES: ReadonlySet<string> = new Set([
  'Create',
  'Update',
  'Delete',
  'Like',
  'Undo',
]);

/** The id an AP `object` names: a bare IRI, or an embedded object's `id`. */
function objectIdOf(value: unknown): string {
  if (typeof value === 'string') return value;
  const id = asRecord(value)?.id;
  return typeof id === 'string' ? id : '';
}

/**
 * Why a relayed activity the caller handles is still not processed, or null.
 *
 * An `Undo` is processed only for a `Like`. And a vote — a `Like`, or the `Undo`
 * of one — only when it concerns a post written HERE: a community relays every
 * member's vote on every post and comment in it, by far the bulk of what it
 * sends, and Mention records engagement aimed at its own users' posts, never a
 * mirror of a remote post's tally (the rule the outbox backfill states for
 * remote aggregate counts). So the rest is dropped before it costs a
 * verification fetch or an actor resolution.
 */
function unprocessedReason(type: string, activity: Record<string, unknown>): string | null {
  let vote = activity;
  if (type === 'Undo') {
    const undone = asRecord(activity.object);
    const undoneType = undone ? primaryApType(undone.type) : undefined;
    if (!undone || undoneType !== 'Like') return `unsupported-Undo-${undoneType ?? 'object'}`;
    vote = undone;
  } else if (type !== 'Like') {
    return null;
  }
  return extractLocalPostIdFromApUri(objectIdOf(vote.object)) ? null : 'remote-vote';
}

/**
 * Verify a relayed activity, returning the copy to process and its actor.
 *
 * Two ways to establish it, and nothing else is trusted:
 *
 * 1. **Same origin as the relayer.** The activity, its actor and any object it
 *    embeds all live on the relaying actor's own origin, whose key signed the
 *    delivery (or whose outbox served it). That server already speaks for every
 *    account and object on its origin, so the embedded copy grants it nothing it
 *    could not deliver directly — the origin-based trust of FEP-fe34.
 * 2. **Fetched from its own origin.** Otherwise — a member of another instance,
 *    the common case in a big community — the embedded copy is a third party's
 *    claim. The activity is re-fetched by its id over the signed, SSRF-safe
 *    transport ({@link fetchFromOrigin}); it must come back with that id, the
 *    same type and an actor on its own origin, and that fetched copy is the one
 *    processed.
 *
 * In both cases an embedded object must share its actor's origin, so a member
 * cannot carry somebody else's post in its `Create`.
 */
async function verifyRelayedActivity(
  inner: Record<string, unknown>,
  type: string,
  relayerUri: string,
): Promise<{ activity: Record<string, unknown>; actorUri: string } | null> {
  const id = typeof inner.id === 'string' && isAbsoluteHttpUrl(inner.id) ? inner.id : undefined;
  if (!id) return null;

  const isSelfConsistent = (activity: Record<string, unknown>, actorUri: string): boolean => {
    const embedded = asRecord(activity.object);
    return (
      sameOrigin(id, actorUri) &&
      (!embedded || (typeof embedded.id === 'string' && sameOrigin(embedded.id, actorUri)))
    );
  };

  const embeddedActor = extractActorUri(inner.actor);
  if (
    embeddedActor &&
    sameOrigin(embeddedActor, relayerUri) &&
    isSelfConsistent(inner, embeddedActor)
  ) {
    return { activity: inner, actorUri: embeddedActor };
  }

  const fetched = await fetchFromOrigin(id);
  if (!fetched || fetched.document.id !== id) return null;
  const activity = fetched.document;
  if (primaryApType(activity.type) !== type) return null;
  const actorUri = extractActorUri(activity.actor);
  if (!actorUri || !isSelfConsistent(activity, actorUri)) return null;
  return { activity, actorUri };
}

/**
 * Read an `Announce`: a boost of an object, or a relayed activity to process as
 * its own actor's.
 *
 * `relayerUri` is the VERIFIED announcing actor — the signer of the inbox
 * delivery, or the owner of the outbox page it came from. `handles` names the
 * inner activity types the caller processes; anything else is dropped without a
 * fetch.
 *
 * An `Announce` that names its object by IRI only is a boost of that IRI, as it
 * always was: the boost import fetches it and refuses anything that is not a
 * post.
 */
export async function resolveAnnouncedActivity(
  announce: Record<string, unknown>,
  relayerUri: string,
  handles: ReadonlySet<string>,
): Promise<AnnouncedActivity> {
  const embedded = asRecord(announce.object);
  const type = embedded ? primaryApType(embedded.type) : undefined;
  if (!embedded || !type || !ACTIVITY_TYPES.has(type)) {
    const objectUri = extractAnnouncedObjectUri(announce.object);
    return objectUri ? { kind: 'object', objectUri } : { kind: 'dropped', reason: 'no-object' };
  }

  if (!handles.has(type)) return { kind: 'dropped', reason: `unsupported-${type}` };
  const unprocessed = unprocessedReason(type, embedded);
  if (unprocessed) return { kind: 'dropped', reason: unprocessed };

  const verified = await verifyRelayedActivity(embedded, type, relayerUri);
  if (!verified) return { kind: 'dropped', reason: 'unverified' };
  return { kind: 'activity', ...verified };
}
