import { qualified } from '@oxy.so/db';
import { eq, or, sql, type SQL } from 'drizzle-orm';
import { postSourceKeys } from '../../db/schema/postContent';
import { posts } from '../../db/schema/posts';

/**
 * ONE Instagram post, TWO roads into Mention — and the key that makes them meet.
 *
 * An Instagram post can arrive:
 *
 *  - from Meta's Graph API (`connectors/instagram/`), whose media carries a
 *    `permalink` of `https://www.instagram.com/p/<shortcode>/` or
 *    `…/reel/<shortcode>/`; or
 *  - pushed by the kilogram.makeup ActivityPub bridge, whose Note id is
 *    `https://kilogram.makeup/users/<username>/statuses/<shortcode>` — measured
 *    live (2026-09-27, `natgeo@kilogram.makeup` through mastodon.social's public
 *    API): `…/statuses/DLmzYr6tcKJ`, `…/statuses/DIzVBJDA8sj`, the same 11-char
 *    shortcodes the Graph permalinks carry. The Note's `url` equals its id.
 *
 * Both reduce to `instagram:<shortcode>`, stored in `post_source_keys.source_key` under
 * a partial UNIQUE index, so whichever road arrives second collides instead of
 * duplicating. The shortcode is case-SENSITIVE (Instagram's base64-ish alphabet),
 * so it is never lowercased.
 *
 * Pure except for {@link postMatchesFederatedObjectSql}, which only builds SQL.
 */

/** Prefix of every Instagram source key (and of a Graph-imported post's activity id). */
export const INSTAGRAM_SOURCE_KEY_PREFIX = 'instagram:';

/**
 * The ActivityPub bridges known to mirror Instagram with the shortcode as the
 * Note's last path segment. A reviewed list, not a pattern: a host that merely
 * LOOKS like a bridge must not be able to claim another post's source key.
 */
export const INSTAGRAM_AP_BRIDGE_HOSTS: ReadonlySet<string> = new Set(['kilogram.makeup']);

/** Instagram's shortcode alphabet. Length-bounded so junk cannot become a key. */
const SHORTCODE_RE = /^[A-Za-z0-9_-]{5,64}$/;

/** The permalink path kinds that name ONE post by shortcode. */
const PERMALINK_KINDS: ReadonlySet<string> = new Set(['p', 'reel', 'reels', 'tv']);

const INSTAGRAM_WEB_HOSTS: ReadonlySet<string> = new Set([
  'instagram.com',
  'www.instagram.com',
  'm.instagram.com',
]);

/** `instagram:<shortcode>`, or undefined for anything that is not a shortcode. */
export function instagramSourceKey(shortcode: string | undefined | null): string | undefined {
  if (!shortcode || !SHORTCODE_RE.test(shortcode)) return undefined;
  return `${INSTAGRAM_SOURCE_KEY_PREFIX}${shortcode}`;
}

/**
 * The shortcode of an Instagram permalink (`/p/<code>/`, `/reel/<code>/`,
 * `/reels/<code>/`, `/tv/<code>/`, optionally under a `/<username>/` prefix).
 * Only instagram.com hosts are accepted.
 */
export function instagramShortcodeFromPermalink(
  permalink: string | undefined | null,
): string | undefined {
  if (!permalink) return undefined;
  let url: URL;
  try {
    url = new URL(permalink);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (!INSTAGRAM_WEB_HOSTS.has(url.hostname.toLowerCase())) return undefined;
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (PERMALINK_KINDS.has(segments[index].toLowerCase())) {
      const code = segments[index + 1];
      return SHORTCODE_RE.test(code) ? code : undefined;
    }
  }
  return undefined;
}

/**
 * The source key of a bridged ActivityPub Note, from its id:
 * `https://kilogram.makeup/users/<username>/statuses/<shortcode>` →
 * `instagram:<shortcode>`. Undefined for every other object — including a
 * kilogram URL of any other shape.
 */
export function instagramSourceKeyFromApObjectUri(
  objectUri: string | undefined | null,
): string | undefined {
  if (!objectUri) return undefined;
  let url: URL;
  try {
    url = new URL(objectUri);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  if (!INSTAGRAM_AP_BRIDGE_HOSTS.has(url.hostname.toLowerCase())) return undefined;
  if (url.search || url.hash) return undefined;
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length !== 4 || segments[0] !== 'users' || segments[2] !== 'statuses')
    return undefined;
  return instagramSourceKey(segments[3]);
}

/**
 * The Note id the kilogram bridge mints (or would mint) for `shortcode` under
 * `actorUri` — used to find a post ingested from the bridge BEFORE
 * `post_source_keys` existed, which carries only its activity id.
 */
export function kilogramNoteIdFor(actorUri: string, shortcode: string): string | undefined {
  const noteId = `${actorUri.replace(/\/+$/, '')}/statuses/${shortcode}`;
  return instagramSourceKeyFromApObjectUri(noteId) ? noteId : undefined;
}

/** True for the activity id a Graph-imported post is stored under. */
export function isInstagramSourceActivityId(activityId: string | undefined | null): boolean {
  return (
    typeof activityId === 'string' &&
    activityId.startsWith(INSTAGRAM_SOURCE_KEY_PREFIX) &&
    SHORTCODE_RE.test(activityId.slice(INSTAGRAM_SOURCE_KEY_PREFIX.length))
  );
}

/**
 * "The stored post that IS this federated object": its own activity id, or — for
 * a bridged Instagram Note — the same Instagram post imported from the Graph API.
 * Every "is this object already here?" gate on the ActivityPub side uses this, so
 * a kilogram push of a post the Graph import already holds links to that row
 * instead of creating a second one.
 */
export function postMatchesFederatedObjectSql(objectUri: string): SQL {
  const sourceKey = instagramSourceKeyFromApObjectUri(objectUri);
  const byActivityId = eq(posts.federationActivityId, objectUri);
  return sourceKey ? (or(byActivityId, postIsSourceKeySql(sourceKey)) as SQL) : byActivityId;
}

/**
 * "This post is the one holding source key `sourceKey`".
 *
 * An UNCORRELATED scalar subquery, on purpose. The obvious spelling — a
 * correlated `exists (… post_id = posts.id …)` — cannot be driven by any index
 * on `posts` inside the `or` above, so every bridged Note turned the inbox
 * dedupe, Delete, Update and object resolution into a sequential scan of
 * `posts` (it stayed one even with `enable_seqscan = off`). This form is
 * evaluated ONCE (an InitPlan through `post_source_keys_source_key_key`), and
 * the `or` becomes a BitmapOr of the activity-id index and the primary key.
 * `source_key` is UNIQUE, so the subquery yields at most one row; a claim
 * (NULL `post_id`) matches nothing.
 */
export function postIsSourceKeySql(sourceKey: string): SQL {
  return sql`${qualified(posts.id)} = (
    select ${qualified(postSourceKeys.postId)} from ${postSourceKeys}
    where ${qualified(postSourceKeys.sourceKey)} = ${sourceKey}
  )`;
}
