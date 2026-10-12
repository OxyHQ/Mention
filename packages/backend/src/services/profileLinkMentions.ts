import {
  MAX_MENTIONS_PER_POST,
  MAX_PROFILE_LINKS_PER_BODY,
  mapMentionTexts,
  mentionTextsFromContent,
  normalizeMentionIds,
  reconcileMentionIds,
} from '@mention/shared-types/mentions';
import {
  fediverseProfilePathSegment,
  isProfileLikeUrl,
  ownProfileUrlHandle,
} from '@mention/shared-types/profileUrls';
import {
  scanTextEntities,
  toOpenableUrl,
  trimUrlTrailingPunctuation,
  type TextEntity,
} from '@mention/shared-types/textEntities';
import {
  findActorByAcct,
  findActorByUri,
  findActorOxyUserIdsByAccts,
} from '../db/federation/actorRepository';
import { isBlockedDomain, resolveOxyUser } from '../connectors/activitypub/constants';
import { OWN_DOMAINS } from '../connectors/activitypub/ownDomain';
import { normalizeFederatedAcct } from '../connectors/activitypub/helpers';
import { logger } from '../utils/logger';
import { createCache } from '../utils/cache';

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
 * A TYPED HANDLE IS THE SAME WORD. `@alice` written by hand names alice exactly as
 * picking her from the composer's list does, and for a long time only the picker
 * counted: a typed handle was stored as prose, so the post showed no mention and
 * alice was never told. {@link foldProfileLinkMentions} now reads the handles in
 * the body too — `@alice` (one of ours), `@alice@<our host>`, and
 * `@bob@remote.tld` for an actor we already store — under the same rules as a
 * link: lookup-only, a handle nobody holds stays text, and the same per-post
 * ceiling. {@link MAX_PROFILE_LINKS_PER_BODY} bounds the handle lookups as it
 * bounds the link lookups, because each one can cost a round trip to Oxy.
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
 * An href that names a profile on one of our own domains (or the Oxy identity
 * apex) is a LOCAL user: resolve it through Oxy by username — NEVER fetch it as a
 * remote actor (that path rejects own/blocked domains). Any other href is a
 * genuine remote actor, resolved through the supplied
 * {@link RemoteMentionResolver} — fetch-and-create for the live inbox path,
 * lookup-only for the repair and profile-link paths. Returns `null` when the
 * actor cannot be resolved to an Oxy user, so the caller leaves the link alone
 * rather than minting a broken mention.
 *
 * THE OWN-HOST BRANCH IS SELECTED BY {@link ownProfileUrlHandle}, not by
 * `isBlockedDomain`, and both halves of that matter:
 *
 *   - `isBlockedDomain` is true for MODERATION-blocked hosts as well as for
 *     ours, so keying the local branch on it asked Oxy to resolve
 *     `https://<blocked-instance>/@alice`'s `alice` as one of OUR users.
 *     Unreachable from ingest, where a blocked domain never gets this far;
 *     reachable the moment this resolver runs on a body somebody composed here.
 *   - it is the same function — with the same percent-decoding — that the
 *     renderer and the composer's roster read, so a handle spelled
 *     `…/@caf%C3%A9` resolves to the account the screen already promised rather
 *     than missing on the raw segment.
 *
 * `isBlockedDomain` still guards the remote arm, and still covers a URL on one
 * of our own hosts whose path is not a profile at all (`https://<us>/about`):
 * that is not a remote actor either, so it resolves to nobody.
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

  const username = ownProfileUrlHandle(href, OWN_DOMAINS);
  if (username) {
    const user = await resolveOxyUser(username);
    const oxyUserId = user ? String(user._id ?? user.id ?? '') : '';
    return oxyUserId ? { oxyUserId, isLocal: true } : null;
  }

  if (isBlockedDomain(host)) return null;

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
  // The path SHAPES come from the shared matcher rather than a second pair of
  // regexes here: the composer gates its mention candidates on the same function,
  // so a shape one side recognised and the other did not would let the two
  // disagree about which links compete for the per-body budget.
  const segment = fediverseProfilePathSegment(href);
  if (!segment) return undefined;
  const path = url.pathname.replace(/\/$/, '');

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
  // Two indexed point lookups rather than one `OR`: both `uri` and `acct` are
  // UNIQUE, so the second only runs when the first missed, and neither can widen
  // into a scan the way a disjunction over two unique keys can.
  const actor = (await findActorByUri(keys.uri)) ?? (await findActorByAcct(keys.acct));
  return actor?.oxyUserId ? actor.oxyUserId : null;
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
 * True when an href could name a user — the gate for spending a lookup on it.
 *
 * The two clauses are the two arms of {@link resolveHrefIdentity} in the same
 * order, so the gate admits exactly what the resolver can answer: a stored
 * remote actor's profile shape, or a profile on one of our own hosts.
 */
export function isProfileLikeHref(href: string): boolean {
  return isProfileLikeUrl(href, OWN_DOMAINS);
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

/**
 * The typed handles of one text, in reading order.
 *
 * Scanned with EVERY kind switched on and filtered afterwards, deliberately: a
 * kind filter on the scan does not stop a handle from matching inside a URL, so
 * `https://poa.st/@alice` scanned for handles alone yields `@alice` — a handle
 * the author never typed, on a host that may be blocked. With URLs, placeholders
 * and display mentions in the scan, each claims its own characters first.
 */
function scanHandles(text: string): TextEntity[] {
  return scanTextEntities(text).filter(
    (entity) => entity.kind === 'bareHandle' || entity.kind === 'federatedHandle',
  );
}

/**
 * The key a typed handle is resolved and matched under: `alice` for a bare
 * handle, `bob@remote.tld` for a two-part one. Lower-cased, because a handle is
 * case-insensitive and `@Alice` and `@alice` in one body are one lookup.
 */
function handleKey(entity: TextEntity): string {
  return entity.value.toLowerCase();
}

/**
 * The distinct handles typed in a set of plain-text renditions, in reading order.
 *
 * Located with the shared entity scanner, so a handle is the same run of
 * characters the reader sees: the `@` of `someone@example.com` opens nothing, a
 * handle inside a URL or a `[mention:<id>]` placeholder stays part of that
 * entity (see {@link scanHandles}), and the full stop of `hola @alice.` is
 * prose, not handle. Pure.
 */
function collectHandleMentions(texts: readonly string[], limit: number): TextEntity[] {
  if (limit <= 0) return [];

  const seen = new Set<string>();
  const handles: TextEntity[] = [];
  for (const text of texts) {
    for (const entity of scanHandles(text)) {
      const key = handleKey(entity);
      if (seen.has(key)) continue;
      seen.add(key);
      handles.push(entity);
      if (handles.length >= limit) return handles;
    }
  }
  return handles;
}

/** How long a handle's answer is trusted: a hit, and a name nobody holds. */
const HANDLE_HIT_TTL_SECONDS = 300;
const HANDLE_MISS_TTL_SECONDS = 60;

/**
 * `username → Oxy id | null`, shared across processes. A typed handle costs a
 * round trip to Oxy, and a name nobody holds costs TWO (`resolveOxyUser` falls
 * back to a search) — and misses are the common case for typed text: `@todos`,
 * a typo, a name from another network. The miss is cached too, briefly, so a
 * thread repeating one does not ask again for every post.
 *
 * Five minutes for a hit matches the Oxy SDK's own in-process cache, so the
 * window in which a renamed account's old handle still resolves is no wider
 * than it already was.
 */
const handleCache = createCache({ name: 'HandleMentionCache', ttlSeconds: HANDLE_HIT_TTL_SECONDS });

function handleCacheKey(username: string): string {
  return `mention:handle:v1:${username.toLowerCase()}`;
}

/**
 * Which stored identity each typed handle names — `handleKey → Oxy id`, only the
 * ones that resolved. Lookup-only, like {@link resolveProfileLinkIdentity}:
 *
 *   - `@alice`, and `@alice@<one of our hosts>`, are OUR user `alice`: the
 *     shared cache first ({@link handleCache}, one `MGET` for the whole body),
 *     then Oxy for what it did not know, concurrently.
 *   - `@bob@remote.tld` is the remote actor we already store under that acct —
 *     ONE indexed query for every remote handle of the body, never a WebFinger.
 *     An actor we have never seen stays text; typing a handle must not make the
 *     server go fetch it.
 *   - a handle on a moderation-blocked host names nobody.
 *
 * Fail-soft per handle: a lookup that throws resolves that handle to nothing
 * (and is not cached), and the rest are unaffected.
 */
async function resolveHandleIdentities(
  entities: readonly TextEntity[],
): Promise<Map<string, string>> {
  /** lower-cased username → the spelling to ask Oxy for, and the handles naming it. */
  const local = new Map<string, { spelling: string; keys: string[] }>();
  /** normalized acct → the handles naming it. */
  const remote = new Map<string, string[]>();

  for (const entity of entities) {
    const key = handleKey(entity);
    let username: string | null = null;
    if (entity.kind === 'bareHandle') {
      username = entity.value;
    } else {
      const at = entity.value.indexOf('@');
      const domain = entity.value.slice(at + 1).toLowerCase();
      if (OWN_DOMAINS.some((own) => own.toLowerCase() === domain)) {
        username = entity.value.slice(0, at);
      } else if (!isBlockedDomain(domain)) {
        const acct = normalizeFederatedAcct(entity.value);
        if (acct) remote.set(acct, [...(remote.get(acct) ?? []), key]);
      }
    }
    if (username) {
      const lower = username.toLowerCase();
      const entry = local.get(lower);
      if (entry) entry.keys.push(key);
      else local.set(lower, { spelling: username, keys: [key] });
    }
  }

  const resolved = new Map<string, string>();
  await Promise.all([
    resolveLocalUsernames(local).then((ids) => {
      for (const [lower, id] of ids) {
        for (const key of local.get(lower)?.keys ?? []) resolved.set(key, id);
      }
    }),
    (async () => {
      if (remote.size === 0) return;
      try {
        const ids = await findActorOxyUserIdsByAccts([...remote.keys()]);
        for (const [acct, id] of ids) {
          for (const key of remote.get(acct) ?? []) resolved.set(key, id);
        }
      } catch (err) {
        logger.warn('[Mentions] failed to resolve typed remote handles in a composed post', {
          error: err,
        });
      }
    })(),
  ]);
  return resolved;
}

/** `lower-cased username → Oxy id` for the local handles that resolved. */
async function resolveLocalUsernames(
  local: ReadonlyMap<string, { spelling: string }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (local.size === 0) return out;

  const names = [...local.keys()];
  const cached = await handleCache.getMany<{ id: string | null }>(names.map(handleCacheKey));
  const misses: string[] = [];
  names.forEach((name, i) => {
    const entry = cached[i];
    if (entry === undefined) misses.push(name);
    else if (entry.id) out.set(name, entry.id);
  });
  if (misses.length === 0) return out;

  const hits: [string, { id: string }][] = [];
  const nobody: [string, { id: null }][] = [];
  await Promise.all(
    misses.map(async (name) => {
      try {
        const user = await resolveOxyUser(local.get(name)?.spelling ?? name);
        const id = user ? String(user._id ?? user.id ?? '') : '';
        if (id) {
          out.set(name, id);
          hits.push([handleCacheKey(name), { id }]);
        } else {
          nobody.push([handleCacheKey(name), { id: null }]);
        }
      } catch (err) {
        // Not cached: an outage is not an answer about the name.
        logger.warn('[Mentions] failed to resolve a typed handle in a composed post', {
          error: err,
        });
      }
    }),
  );
  await Promise.all([
    handleCache.setMany(hits),
    handleCache.setMany(nobody, { ttlSeconds: HANDLE_MISS_TTL_SECONDS }),
  ]);
  return out;
}

/**
 * Replace every typed handle that resolved with the `[mention:<id>]` placeholder,
 * leaving every other character where the author put it. Pure.
 */
function rewriteHandleMentions(text: string, resolved: ReadonlyMap<string, string>): string {
  let rewritten = '';
  let cursor = 0;
  for (const entity of scanHandles(text)) {
    const oxyUserId = resolved.get(handleKey(entity));
    if (!oxyUserId) continue;
    rewritten += `${text.slice(cursor, entity.start)}[mention:${oxyUserId}]`;
    cursor = entity.end;
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
 * Fold every profile link AND every typed handle in a body ABOUT TO BE STORED
 * into that body's mentions: rewrite each one that resolves into the
 * `[mention:<id>]` placeholder the composer's picker produces, and authorize the
 * id it names. Links first, then handles, under one shared per-post ceiling.
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
 * Fail-soft per link and per handle — a lookup that throws leaves that one alone
 * and the rest of the body unaffected. A body with no profile-shaped URL and no
 * typed handle costs two regex passes and does no I/O at all.
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
  const authorized = new Set(mentions);
  let rewritten = false;

  // Links and handles are looked up TOGETHER: neither pass can see the other's
  // characters (a handle inside a URL belongs to the URL — see `scanHandles`),
  // so the handles found before the links are folded are exactly the ones found
  // after. Both are bounded by the headroom up front; the handles are then cut
  // to what the links that actually resolved left of it.
  const limit = Math.min(MAX_PROFILE_LINKS_PER_BODY, headroom);
  const urls = collectProfileLinkUrls(texts, limit);
  const handles = collectHandleMentions(texts, limit);
  const resolvedLinks = new Map<string, string>();
  const [, handleIds] = await Promise.all([
    Promise.all(
      urls.map(async (url) => {
        try {
          const identity = await resolveProfileLinkIdentity(url);
          if (identity) resolvedLinks.set(url, identity.oxyUserId);
        } catch (err) {
          logger.warn('[Mentions] failed to resolve a profile link in a composed post', {
            error: err,
          });
        }
      }),
    ),
    resolveHandleIdentities(handles),
  ]);

  if (resolvedLinks.size > 0) {
    rewritten = mapMentionTexts(content, (text) => rewriteProfileLinks(text, resolvedLinks));
    for (const oxyUserId of resolvedLinks.values()) authorized.add(oxyUserId);
  }

  // Reading order, within what the resolved links left of the per-post ceiling.
  const resolvedHandles = new Map<string, string>();
  const handleHeadroom = headroom - resolvedLinks.size;
  for (const entity of handles) {
    if (resolvedHandles.size >= handleHeadroom) break;
    const key = handleKey(entity);
    const oxyUserId = handleIds.get(key);
    if (oxyUserId) resolvedHandles.set(key, oxyUserId);
  }
  if (resolvedHandles.size > 0) {
    rewritten =
      mapMentionTexts(content, (text) => rewriteHandleMentions(text, resolvedHandles)) || rewritten;
    for (const oxyUserId of resolvedHandles.values()) authorized.add(oxyUserId);
  }

  return { mentions: [...authorized], rewritten };
}
