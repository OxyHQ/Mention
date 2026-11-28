import { stripTextEntities } from '@mention/shared-types/textEntities';
import { htmlToPlainText } from '../../utils/federation/htmlToPlainText';
import { getRemoteHost } from '../shared/url';
import { extractApContentHtml } from './apPostContent';
import { dropsFlattenedReposts } from './repostTransportPolicy';

/**
 * A retweet a bridge FLATTENED into an ordinary post, which we cannot render as
 * the repost it is.
 *
 * mastox.eu (a stock Mastodon that mirrors X accounts) does not emit an
 * ActivityPub `Announce` for a retweet. It publishes a plain Note, authored by
 * the RETWEETER, whose body opens `RT: @original` — and the object carries
 * nothing else: `inReplyTo` null, no quote field, no link to the upstream post,
 * no tweet id (its status ids are Mastodon snowflakes), at most a `Mention` tag
 * pointing at mastox's own mirror of the original author. Some render that
 * author as an h-card mention anchor, some as bare text.
 *
 * So the post appears under the wrong byline: Pablo Iglesias signing text Julio
 * wrote, with no way to reach the original. These are dropped rather than
 * published under a name that did not write them. A retweet is only ever stored
 * as a boost of the original under its real author, and for X the one source
 * that says which original is meant is bird.makeup: current BirdsiteLive emits a
 * real `Announce` whose object is the original Note, attributed to its author
 * and fetchable by its tweet id (`outboxSyncService.importAnnounce`).
 *
 * THE DECISION IS MADE ON THE BRIDGE'S OWN TEXT. It reads the visible plain text
 * of the content the bridge published — a mention anchor counts as the `@handle`
 * it shows — BEFORE Mention rewrites anything. It used to run on the stored body
 * instead, after each resolved mention had become a `[mention:<id>]` placeholder,
 * so every retweet whose author the bridge tagged (`RT: <a class="mention">…`)
 * slipped through as `RT: [mention:…]`: 331 such posts were stored from mastox.
 * Each ingest site calls {@link isBridgeFlattenedRetweet} before it resolves the
 * note's mentions, which also spares minting accounts for a note it drops.
 *
 * IT IS THE ONLY PLACE THAT READS A BODY TO DECIDE SOMETHING, and it is narrow
 * because the two directions of failure are not alike: a MISSED retweet stores
 * a post under the wrong byline, while a FALSE match discards a real post. Hence
 * the marker is anchored at position 0, `RT:` then `@`, and only actors on a
 * REVIEWED bridge are tested, so an ordinary fediverse user opening a post with
 * "RT:" is never touched. bird.makeup stays on the list: it does not flatten
 * today, but older BirdsiteLive builds did (one stored sample), and the rule
 * costs nothing on a bridge that sends Announces.
 */
const RETWEET_MARKER = /^RT:\s?@/;

/** Whether a reviewed bridge's actor at `actorUri` published `note` as a flattened retweet. */
export function isBridgeFlattenedRetweet(
  note: Record<string, unknown>,
  actorUri: string | undefined,
): boolean {
  if (!isReviewedBridgeActor(actorUri)) return false;
  return RETWEET_MARKER.test(htmlToPlainText(extractApContentHtml(note)).trim());
}

/**
 * The same decision for a body Mention ALREADY STORED, which no longer holds the
 * bridge's markup: the mention the bridge wrote is now a `[mention:<id>]`
 * placeholder or a `[@label](link)`. Each is read back as the `@` mention it
 * was, and the marker is tested exactly as at ingest. For the one-shot that
 * removes rows stored before the gate saw the bridge's own text.
 */
export function isStoredBridgeFlattenedRetweet(body: string, actorUri: string): boolean {
  if (!isReviewedBridgeActor(actorUri)) return false;
  const visible = stripTextEntities(body, {
    kinds: ['mentionPlaceholder', 'mentionDisplay'],
    replacement: '@mention',
  });
  return RETWEET_MARKER.test(visible.trim());
}

function isReviewedBridgeActor(actorUri: string | undefined): boolean {
  const host = actorUri ? getRemoteHost(actorUri) : undefined;
  return host !== undefined && dropsFlattenedReposts(host);
}
