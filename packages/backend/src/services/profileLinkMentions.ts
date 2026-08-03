import {
  MAX_MENTIONS_PER_POST,
  mapMentionTexts,
  mentionTextsFromContent,
  normalizeMentionIds,
  reconcileMentionIds,
} from '@mention/shared-types/mentions';
import { localProfilePathHandle } from '@mention/shared-types/profileUrls';
import {
  scanTextEntities,
  toOpenableUrl,
  trimUrlTrailingPunctuation,
} from '@mention/shared-types/textEntities';
import FederatedActor from '../models/FederatedActor';
import { isBlockedDomain, resolveOxyUser } from '../connectors/activitypub/constants';
import { normalizeFederatedAcct } from '../connectors/activitypub/helpers';
import { logger } from '../utils/logger';

/**
 * A PROFILE LINK IN A BODY IS A MENTION, AND THE ANSWER IS THE SAME WHOEVER WROTE IT.
 *
 * Somebody who pastes `https://mastodon.social/@alice` into a post has written
 * alice's name. The inbound-federation ingest has always read it that way — an
 * unclaimed profile link in an incoming Note is folded into the note's real
 * mentions before it is stored — while a post composed HERE kept the bare URL,
 * because the native controller took `mentions` straight off the request body
 * and so only ever saw what the composer's picker had sent. Same characters, two
 * answers, decided by which side of the wire the author happened to be on.
 *
 * This module is the one mechanism both sides now use. It owns:
 *   - {@link resolveProfileLinkIdentity} — which stored identity, if any, a
 *     profile URL names. The inbound path calls it for the anchors no `Mention`
 *     tag claimed; the native write boundary calls it for the URLs in the body
 *     the author just typed.
 *   - {@link foldProfileLinkMentions} — the native write boundary itself: rewrite
 *     each resolved link into the `[mention:<id>]` placeholder the composer's own
 *     picker produces, and authorize that id.
 *
 * NOTHING HERE EVER FETCHES THE PASTED URL. A URL in a body is arbitrary
 * author-controlled text; dereferencing one would turn every post into a request
 * to a host of the author's choosing, with unbounded fan-out. Every answer comes
 * from identities we already store — see {@link lookupExistingActorByProfileHref}.
 *
 * A LINK WE CANNOT RESOLVE STAYS A LINK. A stored mention that resolves to
 * nobody is worse than the URL it replaced: it renders as inert text where a
 * working link used to be, and it would be the author's own body that we broke.
 *
 * A RESOLVED LINK IS AUTHORSHIP, deliberately. The id lands in `post.mentions`,
 * which is the same allowlist that puts the post in that person's mentions feed
 * and notifies them. That is what the inbound path already does with the exact
 * same URL, and what pasting somebody's profile link means. The bound on it is
 * {@link MAX_PROFILE_LINKS_PER_BODY}, narrowed further by whatever headroom the
 * body's existing mentions leave under `MAX_MENTIONS_PER_POST` — the two mention
 * sources share ONE per-post ceiling.
 *
 * Not to be confused with the reading-surface conversion in the frontend's
 * `linkifyPattern`, which re-labels a link to a profile on THIS instance as a
 * mention at RENDER time and creates nothing. That one is the fallback for the
 * bodies already stored and for bodies we did not write; this one is what keeps
 * new bodies from needing it.
 */

/** A mentioned actor resolved to its Oxy user id and locality. */
export interface MentionActorResolution {
  /** The mentioned actor's Oxy user id (federated OR local). */
  oxyUserId: string;
  /** True when the actor is a LOCAL Mention user — the only notification target. */
  isLocal: boolean;
}

/**
 * Resolve a mentioned actor URI that is NOT one of our own/blocked domains — i.e.
 * a genuine REMOTE actor — to its stored Oxy user id, or `null` when it cannot be
 * resolved. The mention paths differ ONLY here: the live inbox path
 * fetches-and-creates the actor when unknown; the repair path and every
 * profile-link path look it up without any network fetch or create.
 */
export type RemoteMentionResolver = (href: string) => Promise<string | null>;

/**
 * Resolve one mentioned actor URI to its Oxy user id.
 *
 * An href on one of our own domains (or the Oxy identity apex) is a LOCAL user:
 * resolve it through Oxy by username — NEVER fetch it as a remote actor (that path
 * rejects own/blocked domains). Any other href is a genuine remote actor, resolved
 * through the supplied {@link RemoteMentionResolver} — fetch-and-create for the
 * live inbox path, lookup-only for the repair and profile-link paths. Returns
 * `null` when the actor cannot be resolved to an Oxy user, so the caller leaves
 * the link alone rather than minting a broken mention.
 */
export async function resolveHrefIdentity(
  href: string,
  resolveRemote: RemoteMentionResolver,
): Promise<MentionActorResolution | null> {
  let host: string;
  try {
    host = new URL(href).hostname.toLowerCase();
  } catch {
    return null;
  }

  if (isBlockedDomain(host)) {
    // The host was just established as one of ours (or the Oxy identity apex), so
    // reading the handle out of the path alone is safe here — see the host-gate
    // note on `localProfilePathHandle`.
    const username = localProfilePathHandle(href);
    if (!username) return null;
    const user = await resolveOxyUser(username);
    const oxyUserId = user ? String(user._id ?? user.id ?? '') : '';
    return oxyUserId ? { oxyUserId, isLocal: true } : null;
  }

  const oxyUserId = await resolveRemote(href);
  return oxyUserId ? { oxyUserId, isLocal: false } : null;
}

/**
 * The stored-identity lookup keys a fediverse PROFILE URL implies, when the href
 * has one of the two shapes every server publishes a profile at:
 *   - `https://<host>/@<user>` — the human profile page (and its
 *     `https://<host>/@<user>@<origin-host>` form for a REMOTE profile rendered by
 *     an instance, where the trailing host is the one that actually owns the user);
 *   - `https://<host>/users/<user-or-opaque-id>` — the Mastodon/Pleroma actor URI,
 *     which Misskey-family servers key by an opaque id rather than the username.
 *
 * Both keys are emitted because neither shape tells us which one the stored row is
 * keyed by: a `/users/<id>` href IS the actor `uri`, while a `/@<user>` href is
 * only ever matchable via the `acct`. Both are unique+indexed on `FederatedActor`,
 * so the pair costs one indexed lookup. Returns undefined for any other URL shape
 * — the overwhelmingly common case for an ordinary link, which then costs nothing.
 */
interface ProfileHrefKeys {
  /** `origin + pathname` (no query/fragment/trailing slash) — the actor-URI key. */
  uri: string;
  /** The canonical `user@domain` acct key, in the lowercased form rows store. */
  acct: string;
}

function profileHrefKeys(href: string): ProfileHrefKeys | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;

  const path = url.pathname.replace(/\/$/, '');
  const segment = /^\/@([^/]+)$/.exec(path)?.[1] ?? /^\/users\/([^/]+)$/.exec(path)?.[1];
  if (!segment) return undefined;

  // A username with non-ASCII characters arrives percent-encoded in `pathname`,
  // while `acct` is stored decoded. A malformed escape is not decodable — keep the
  // raw segment for it, which simply fails to match any stored acct.
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    decoded = segment;
  }

  // `@user@owner-host` already carries its own domain; a bare `user` takes the
  // host serving the page. `normalizeFederatedAcct` applies the SAME canonical
  // lowercasing/validation the actor rows were written with.
  const acct = normalizeFederatedAcct(
    decoded.includes('@') ? decoded : `${decoded}@${url.hostname}`,
  );
  if (!acct) return undefined;

  return { uri: `${url.origin}${path}`, acct };
}

/**
 * Resolve a bare PROFILE LINK — a URL in a body, with no `Mention` tag and no
 * picker selection behind it — against ALREADY-STORED `FederatedActor` rows only.
 *
 * This resolver is LOOKUP-ONLY on EVERY path, including the live inbox path,
 * which does fetch-and-create for a real `Mention` tag. A tag is a machine-readable
 * addressing declaration from the origin server; a URL sitting in post content is
 * arbitrary author-controlled text, and dereferencing it would turn any post into
 * a request to a host of the author's choosing (SSRF) with unbounded fan-out. So
 * an unknown profile URL resolves to `null` and the link is left exactly as the
 * author wrote it — never fetched, never created.
 */
const lookupExistingActorByProfileHref: RemoteMentionResolver = async (href) => {
  const keys = profileHrefKeys(href);
  if (!keys) return null;
  const actor = await FederatedActor.findOne(
    { $or: [{ uri: keys.uri }, { acct: keys.acct }] },
    { oxyUserId: 1 },
  ).lean<{ oxyUserId?: string } | null>();
  return actor?.oxyUserId ? String(actor.oxyUserId) : null;
};

/**
 * Which identity a PROFILE LINK names, among the ones we already store — the one
 * question both the inbound ingest and the native write boundary ask.
 *
 * Lookup-only by construction: the remote arm is
 * {@link lookupExistingActorByProfileHref} and there is no seam to pass a
 * fetching one. `null` means "we do not know who this is", and every caller
 * leaves the link untouched on `null`.
 */
export async function resolveProfileLinkIdentity(
  href: string,
): Promise<MentionActorResolution | null> {
  return resolveHrefIdentity(href, lookupExistingActorByProfileHref);
}

/**
 * Max distinct profile links resolved per body. A link-heavy post must not turn
 * into an unbounded burst of lookups (nor, since a resolved link becomes a real
 * mention, into an unbounded burst of notifications) — beyond the cap the extra
 * links stay ordinary links, which is the pre-existing behavior for all of them.
 */
export const MAX_PROFILE_LINKS_PER_BODY = 8;

/** True when an href could name a user — the gate for spending a lookup on it. */
export function isProfileLikeHref(href: string): boolean {
  return profileHrefKeys(href) !== undefined || localProfilePathHandle(href) !== undefined;
}

/**
 * The distinct profile-shaped URLs of a set of plain-text renditions, in reading
 * order, already given a scheme so they can be resolved and matched.
 *
 * URLs are located with the shared entity scanner rather than a second regex, so
 * a run of characters this counts as a link is the same run the reader sees
 * linked and the same run the link-preview warmer resolves. Trailing prose
 * punctuation is cut with {@link trimUrlTrailingPunctuation} — `…/@alice.` names
 * alice and ends a sentence — and `toOpenableUrl` supplies the scheme a pasted
 * `www.…` form omits, so both spellings resolve to the same identity.
 *
 * Ordinary links are filtered out by SHAPE before any I/O, so the overwhelmingly
 * common link-in-a-post case costs one regex pass and nothing else. Pure.
 */
function collectProfileLinkUrls(texts: readonly string[], limit: number): string[] {
  if (limit <= 0) return [];

  const seen = new Set<string>();
  const urls: string[] = [];
  for (const text of texts) {
    for (const entity of scanTextEntities(text, { kinds: ['url'] })) {
      const { url } = trimUrlTrailingPunctuation(entity.value);
      if (!url) continue;
      const openable = toOpenableUrl(url);
      if (seen.has(openable)) continue;
      if (!isProfileLikeHref(openable)) continue;
      seen.add(openable);
      urls.push(openable);
      if (urls.length >= limit) return urls;
    }
  }
  return urls;
}

/**
 * Replace every profile link that resolved with the `[mention:<id>]` placeholder,
 * leaving every other character — including punctuation that merely trailed the
 * link — exactly where the author put it. Pure.
 */
function rewriteProfileLinks(text: string, resolved: ReadonlyMap<string, string>): string {
  let rewritten = '';
  let cursor = 0;
  for (const entity of scanTextEntities(text, { kinds: ['url'] })) {
    const { url } = trimUrlTrailingPunctuation(entity.value);
    if (!url) continue;
    const oxyUserId = resolved.get(toOpenableUrl(url));
    if (!oxyUserId) continue;
    // The span replaced is the LINK, not the whole matched run: cutting it short
    // at `url.length` is what leaves the trailing `.` of `…/@alice.` in the prose.
    rewritten += `${text.slice(cursor, entity.start)}[mention:${oxyUserId}]`;
    cursor = entity.start + url.length;
  }
  return cursor === 0 ? text : rewritten + text.slice(cursor);
}

/** What {@link foldProfileLinkMentions} did to a body. */
export interface ProfileLinkMentionFold {
  /**
   * The mention allowlist to reconcile against: the caller's own ids plus every
   * id a profile link in the body resolved to.
   */
  mentions: string[];
  /** True when a link in the body was rewritten into a placeholder. */
  rewritten: boolean;
}

/**
 * Fold every profile link in a body ABOUT TO BE STORED into that body's mentions:
 * rewrite the link into the `[mention:<id>]` placeholder the composer's picker
 * produces, and authorize the id it names.
 *
 * `content` is rewritten IN PLACE — exactly the renditions
 * `mentionTextsFromContent` reads, through the one traversal both directions
 * share (`mapMentionTexts`). Rewriting the body is not incidental: the id alone
 * does nothing, because `reconcileMentionIds` drops any id with no placeholder
 * behind it, and hydration renders the mention off the placeholder. It is also
 * what stops the link from being read twice — once the URL is gone from the
 * stored body there is no URL left for the reading surface to re-label, and none
 * for the link-preview warmer to fetch a card for.
 *
 * The returned `mentions` are AUTHORIZATION, not the final list: the caller still
 * runs it through `reconcileMentionIdsForPost`, which is where the per-post
 * ceiling and the placeholder intersection actually hold.
 *
 * Fail-soft per link — a lookup that throws leaves that one link alone and the
 * rest of the body unaffected. A body with no profile-shaped URL costs one regex
 * pass and does no I/O at all.
 */
export async function foldProfileLinkMentions(
  content: unknown,
  authorizedIds: unknown,
): Promise<ProfileLinkMentionFold> {
  const mentions = normalizeMentionIds(authorizedIds);
  const texts = mentionTextsFromContent(content);
  if (texts.length === 0) return { mentions, rewritten: false };

  // Headroom is measured against the mentions the body ALREADY carries — the ids
  // that both have a placeholder in the text and are authorized — rather than
  // against the raw request allowlist, which may name ids the author removed from
  // the body and which `reconcileMentionIds` is about to drop anyway.
  const headroom = MAX_MENTIONS_PER_POST - reconcileMentionIds(texts, mentions).length;
  const urls = collectProfileLinkUrls(texts, Math.min(MAX_PROFILE_LINKS_PER_BODY, headroom));
  if (urls.length === 0) return { mentions, rewritten: false };

  const resolved = new Map<string, string>();
  await Promise.all(
    urls.map(async (url) => {
      try {
        const identity = await resolveProfileLinkIdentity(url);
        if (identity) resolved.set(url, identity.oxyUserId);
      } catch (err) {
        logger.warn('[Mentions] failed to resolve a profile link in a composed post', {
          error: err,
        });
      }
    }),
  );
  if (resolved.size === 0) return { mentions, rewritten: false };

  const rewritten = mapMentionTexts(content, (text) => rewriteProfileLinks(text, resolved));

  const authorized = new Set(mentions);
  for (const oxyUserId of resolved.values()) authorized.add(oxyUserId);
  return { mentions: [...authorized], rewritten };
}
