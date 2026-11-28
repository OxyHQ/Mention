import { upstreamPostKey } from './upstreamPostKey';

/**
 * The Instagram spelling of the upstream post key (`./upstreamPostKey.ts`).
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
 * Both reduce to `instagram:<shortcode>`. The shortcode is case-SENSITIVE
 * (Instagram's base64-ish alphabet), so it is never lowercased. These are the
 * Graph import's helpers; the bridge side needs nothing beyond the generic key.
 */

/** Prefix of every Instagram source key (and of a Graph-imported post's activity id). */
export const INSTAGRAM_SOURCE_KEY_PREFIX = 'instagram:';

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
 * The Note id the kilogram bridge mints (or would mint) for `shortcode` under
 * `actorUri` — used to find a post ingested from the bridge BEFORE
 * `post_source_keys` existed, which carries only its activity id.
 */
export function kilogramNoteIdFor(actorUri: string, shortcode: string): string | undefined {
  const noteId = `${actorUri.replace(/\/+$/, '')}/statuses/${shortcode}`;
  const key = instagramSourceKey(shortcode);
  return key && upstreamPostKey(noteId) === key ? noteId : undefined;
}

/** True for the activity id a Graph-imported post is stored under. */
export function isInstagramSourceActivityId(activityId: string | undefined | null): boolean {
  return (
    typeof activityId === 'string' &&
    activityId.startsWith(INSTAGRAM_SOURCE_KEY_PREFIX) &&
    SHORTCODE_RE.test(activityId.slice(INSTAGRAM_SOURCE_KEY_PREFIX.length))
  );
}
