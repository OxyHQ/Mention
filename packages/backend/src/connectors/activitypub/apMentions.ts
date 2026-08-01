import { logger } from '../../utils/logger';
import FederatedActor from '../../models/FederatedActor';
import { actorService } from './actor.service';
import { getApContentMap } from './apLanguage';
import { primaryApType } from './apSchemas';
import { bridgedMentionAnchorHrefs } from './bridgy';
import { isBlockedDomain, resolveOxyUser } from './constants';
import { normalizeFederatedAcct, runWithTimeout } from './helpers';

/**
 * INBOUND @mention ingestion for federated ActivityPub Notes.
 *
 * A remote Note carries its @mentions in TWO parallel places:
 *   1. the visible content HTML — a Mastodon-style anchor,
 *      `<span class="h-card"><a href="…" class="u-url mention">@<span>alice</span></a></span>`;
 *   2. the machine-readable `tag` array — one `{ type:'Mention', href:<actorUri>,
 *      name:'@alice@host' }` per mention.
 *
 * The `tag` array is authoritative (it carries the actor URI); the anchor is what
 * the reader sees. Left untouched, {@link htmlToPlainText} strips the anchor to the
 * bare visible text `@alice` — no domain, no link — and the `tag` array is ignored,
 * so the mention renders as dead plain text.
 *
 * This module resolves each `Mention` tag's actor URI to the synced federated (or
 * local) Oxy user id, then rewrites the matching content anchor into Mention's
 * internal `[mention:<oxyUserId>]` placeholder — the SAME placeholder the native
 * composer and the outbound Note builder use. Once stored as a placeholder,
 * {@link PostHydrationService} renders it back into `@alice@host` linking to that
 * user's profile via `getNormalizedUserHandle`, exactly like a native mention.
 *
 * A PROFILE LINK with no `Mention` tag behind it — someone pasted
 * `https://mastodon.social/@alice` into a post, or the origin's tag failed to
 * resolve — is resolved the same way and rewritten into the same placeholder, but
 * STRICTLY LOOKUP-ONLY: see {@link lookupExistingActorByProfileHref}.
 *
 * Anchor↔tag matching is BY HREF (never the ambiguous bare `@username` text): the
 * anchor's `href` is compared against the deterministic candidates each resolved
 * tag implies — the actor URI itself (Pleroma, and our own round-tripped posts)
 * and the reconstructed human profile URLs `https://<domain>/@<user>`
 * (Mastodon/Misskey, whose in-content anchor points at the profile page, not the
 * actor URI). See {@link reconstructProfileHrefs} for why the domain must come
 * from the actor URI's origin and not only from the tag `name`. An anchor that
 * matches none is left untouched and degrades to the prior bare-text behavior
 * rather than mis-linking.
 */

/** One `Mention` entry extracted from an AP object's `tag` array. */
export interface InboundMentionTag {
  /** The mentioned actor's URI (the tag's `href`). */
  href: string;
  /** The `@user@domain` handle (the tag's `name`), when present. */
  name?: string;
}

/** The resolved mentions of a single inbound Note. */
export interface ResolvedInboundMentions {
  /**
   * Every resolved mentioned Oxy user id (federated AND local), deduped — stored
   * verbatim as the post's `mentions` allowlist so hydration can render each
   * `[mention:<id>]` placeholder.
   */
  ids: string[];
  /**
   * The subset of {@link ids} that are LOCAL Mention users — the only mention
   * recipients with a Mention inbox, and thus the only notification targets.
   */
  localIds: string[];
  /**
   * Normalized candidate anchor `href` → mentioned Oxy user id, consumed by
   * {@link applyMentionPlaceholders} to rewrite in-content anchors. Empty when no
   * tag resolved (the common no-mention case), which makes the rewrite a no-op.
   */
  anchorMap: Map<string, string>;
}

/** A mentioned actor resolved to its Oxy user id and locality. */
export interface MentionActorResolution {
  /** The mentioned actor's Oxy user id (federated OR local). */
  oxyUserId: string;
  /** True when the actor is a LOCAL Mention user — the only notification target. */
  isLocal: boolean;
}

/** Matches a whole `<a …>…</a>` anchor, capturing its `href`. Anchors never nest. */
const MENTION_ANCHOR_REGEX = /<a\b[^>]*?\bhref="([^"]*)"[^>]*>.*?<\/a>/gis;

/**
 * Canonicalize an actor/profile href for equality matching: drop the fragment and
 * any trailing slash and lowercase the whole thing, so `https://Host/@Alice#x/` and
 * `https://host/@alice` compare equal. Both sides of every comparison run through
 * this, so lowercasing the path (usernames are matched case-insensitively) is safe.
 */
function normalizeActorHref(href: string): string {
  try {
    const url = new URL(href);
    url.hash = '';
    let normalized = url.toString().toLowerCase();
    if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
    return normalized;
  } catch {
    return href.trim().toLowerCase().replace(/#.*$/, '').replace(/\/$/, '');
  }
}

/**
 * Reconstruct the human profile URL(s) (`https://<domain>/@<user>`) a `Mention`
 * tag implies. This is the in-content anchor href Mastodon and Misskey emit
 * (their anchor points at the profile page, not the actor URI), so it is the
 * candidate that lets those servers' anchors match their own `Mention` tag.
 *
 * The domain comes from TWO independent places, because the tag `name` alone is
 * not enough: Mastodon writes `name` RELATIVE TO THE AUTHOR, so a mention of
 * someone on the author's own instance is the BARE `@user` with no `@domain`
 * suffix — only a cross-instance mention carries `@user@domain`. Deriving the
 * domain solely from `name` therefore produced NO candidate at all for the most
 * common shape of all (two users of the same remote instance talking to each
 * other): the anchor matched nothing, stayed raw, and `htmlToPlainText` stripped
 * it to dead `@user` text with no domain and no link.
 *
 * So the username is taken from `name` (never guessed from the href path, which
 * carries an opaque id on servers like Misskey) and paired with the domain from
 * `name` when it has one AND with the tag href's own origin. Both are emitted;
 * an extra candidate that no anchor uses is inert, since matching is by exact
 * normalized href.
 *
 * Returns an empty array when the name is absent or carries no usable username.
 */
function reconstructProfileHrefs(tag: InboundMentionTag): string[] {
  const cleaned = (tag.name ?? '').replace(/^@+/, '').trim();
  if (!cleaned) return [];

  const at = cleaned.indexOf('@');
  const local = at === -1 ? cleaned : cleaned.slice(0, at);
  const nameDomain = at === -1 ? undefined : cleaned.slice(at + 1) || undefined;
  if (!local) return [];

  const hrefs: string[] = [];
  if (nameDomain) hrefs.push(`https://${nameDomain}/@${local}`);

  // The actor URI's own origin — the instance that actually serves the profile
  // page, and the only source of the domain when `name` is the bare form.
  let actorOrigin: string | undefined;
  try {
    actorOrigin = new URL(tag.href).origin;
  } catch {
    actorOrigin = undefined;
  }
  if (actorOrigin) hrefs.push(`${actorOrigin}/@${local}`);

  return hrefs;
}

/**
 * Extract the local username from an href that points at one of OUR OWN users —
 * either our minted actor URI (`/ap/users/<username>`) or our human profile URL
 * (`/@<username>`). Returns `undefined` for any other shape.
 */
function extractLocalUsername(href: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(href).pathname;
  } catch {
    return undefined;
  }
  const actorMatch = pathname.match(/^\/ap\/users\/([^/]+)\/?$/);
  if (actorMatch) return actorMatch[1];
  const profileMatch = pathname.match(/^\/@([^/]+)\/?$/);
  if (profileMatch) return profileMatch[1];
  return undefined;
}

/** Parse the `Mention` entries out of an AP object's `tag` array. Pure. */
export function extractMentionTags(object: Record<string, unknown>): InboundMentionTag[] {
  const tag = object.tag;
  if (!Array.isArray(tag)) return [];

  const tags: InboundMentionTag[] = [];
  for (const entry of tag) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as { type?: unknown; href?: unknown; name?: unknown };
    if (primaryApType(record.type as string | string[] | undefined) !== 'Mention') continue;
    if (typeof record.href !== 'string' || record.href.trim().length === 0) continue;
    tags.push({
      href: record.href.trim(),
      name: typeof record.name === 'string' ? record.name.trim() : undefined,
    });
  }
  return tags;
}

/**
 * Resolve a mentioned actor URI that is NOT one of our own/blocked domains — i.e.
 * a genuine REMOTE actor — to its stored Oxy user id, or `null` when it cannot be
 * resolved. The two mention paths differ ONLY here: the live inbox path
 * fetches-and-creates the actor when unknown; the repair path looks it up without
 * any network fetch or create.
 */
type RemoteMentionResolver = (href: string) => Promise<string | null>;

/**
 * Live-path remote resolver: resolve — and SYNC/CREATE if new — the remote actor
 * through {@link ActorService.getOrFetchActor}. Used only by the inbox ingest path,
 * where discovering a first-seen mentioned actor is desired.
 */
const fetchOrCreateRemoteActorOxyId: RemoteMentionResolver = async (href) => {
  const actor = await actorService.getOrFetchActor(href);
  return actor?.oxyUserId ? String(actor.oxyUserId) : null;
};

/**
 * Repair-path remote resolver: resolve the remote actor against ALREADY-STORED
 * `FederatedActor` rows ONLY (keyed by its URI, exactly as `getOrFetchActor` keys
 * its own lookup). NEVER performs a network fetch and NEVER creates a row — an
 * actor with no stored row (or a stored row not yet linked to an Oxy user)
 * resolves to `null`, so the caller SKIPS it. That is what keeps a bulk one-shot
 * repair from minting 0-post ghost federated actors for every account a legacy
 * post happened to mention (including deleted/spam accounts that now 410 Gone).
 */
const lookupExistingRemoteActorOxyId: RemoteMentionResolver = async (href) => {
  const actor = await FederatedActor.findOne({ uri: href }, { oxyUserId: 1 }).lean<{
    oxyUserId?: string;
  } | null>();
  return actor?.oxyUserId ? String(actor.oxyUserId) : null;
};

/**
 * Resolve one mentioned actor URI to its Oxy user id.
 *
 * An href on one of our own domains (or the Oxy identity apex) is a LOCAL user:
 * resolve it through Oxy by username — NEVER fetch it as a remote actor (that path
 * rejects own/blocked domains). Any other href is a genuine remote actor, resolved
 * through the supplied {@link RemoteMentionResolver} — fetch-and-create for the
 * live inbox path, lookup-only for the repair path. Returns `null` when the actor
 * cannot be resolved to an Oxy user, so the caller leaves the anchor as bare text
 * rather than minting a broken link.
 */
async function resolveMentionOxyId(
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
    const username = extractLocalUsername(href);
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
 * Resolve a bare PROFILE LINK (an in-content anchor with no `Mention` tag behind
 * it) against ALREADY-STORED `FederatedActor` rows only.
 *
 * This resolver is LOOKUP-ONLY on EVERY path — including the live inbox path,
 * which does fetch-and-create for a real `Mention` tag. A tag is a machine-readable
 * addressing declaration from the origin server; a URL sitting in post content is
 * arbitrary attacker-controlled text, and dereferencing it would turn any inbound
 * post into a request to a host of the author's choosing (SSRF) with unbounded
 * fan-out. So an unknown profile URL resolves to `null` and its anchor is left
 * exactly as it is today — never fetched, never created.
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
 * Max distinct profile links resolved per note. A link-heavy post must not turn
 * into an unbounded burst of lookups (nor, since a resolved link becomes a real
 * mention, into an unbounded burst of notifications) — beyond the cap the extra
 * links stay ordinary links, which is the pre-existing behavior for all of them.
 */
const MAX_CONTENT_PROFILE_LINKS = 8;

/** True when an href could name a user — the gate for spending a lookup on it. */
function isProfileLikeHref(href: string): boolean {
  return profileHrefKeys(href) !== undefined || extractLocalUsername(href) !== undefined;
}

/**
 * The distinct profile-shaped anchor hrefs of a note's HTML bodies that no
 * resolved `Mention` tag already claims — the candidates for
 * {@link addContentProfileMentions}. Ordinary links are filtered out by shape
 * before any I/O, so the common case costs one regex pass and nothing else. Pure.
 */
function collectContentProfileHrefs(
  object: Record<string, unknown>,
  anchorMap: ReadonlyMap<string, string>,
): string[] {
  const bodies: string[] = [];
  if (typeof object.content === 'string') bodies.push(object.content);
  const contentMap = getApContentMap(object);
  if (contentMap) {
    for (const value of Object.values(contentMap)) {
      if (typeof value === 'string') bodies.push(value);
    }
  }

  const seen = new Set<string>();
  const hrefs: string[] = [];
  for (const body of bodies) {
    if (!body.includes('<a')) continue;
    for (const match of body.matchAll(MENTION_ANCHOR_REGEX)) {
      const href = match[1];
      if (!href) continue;
      const normalized = normalizeActorHref(href);
      // Already claimed by a resolved tag, or already collected from another body.
      if (anchorMap.has(normalized) || seen.has(normalized)) continue;
      if (!isProfileLikeHref(href)) continue;
      seen.add(normalized);
      hrefs.push(href);
      if (hrefs.length >= MAX_CONTENT_PROFILE_LINKS) return hrefs;
    }
  }
  return hrefs;
}

/**
 * Fold every in-content PROFILE LINK that resolves to a known identity into the
 * note's mentions, so a pasted `https://mastodon.social/@alice` renders as the
 * real `@alice@mastodon.social` mention — display name, working profile link —
 * instead of a raw URL with a bogus link-preview card behind it.
 *
 * A resolved profile link becomes a FULL mention (it lands in `ids` AND, for a
 * local user, in `localIds`), because the reader is shown a mention and half a
 * mention would be the odd behavior: the id has to be in the post's `mentions`
 * allowlist for hydration to render the placeholder at all, and that same
 * allowlist is what puts the post in the mentioned user's mentions feed — so
 * withholding only the notification would be an inconsistency, not a safeguard.
 * The bound on that is {@link MAX_CONTENT_PROFILE_LINKS}.
 *
 * Fail-soft and lookup-only per link (see {@link lookupExistingActorByProfileHref}):
 * a link that resolves to nothing is left exactly as it is today.
 */
async function addContentProfileMentions(
  object: Record<string, unknown>,
  into: { ids: Set<string>; localIds: Set<string>; anchorMap: Map<string, string> },
): Promise<void> {
  const hrefs = collectContentProfileHrefs(object, into.anchorMap);
  if (hrefs.length === 0) return;

  await Promise.all(
    hrefs.map(async (href) => {
      try {
        const resolved = await resolveMentionOxyId(href, lookupExistingActorByProfileHref);
        if (!resolved) return;
        into.ids.add(resolved.oxyUserId);
        if (resolved.isLocal) into.localIds.add(resolved.oxyUserId);
        into.anchorMap.set(normalizeActorHref(href), resolved.oxyUserId);
      } catch (err) {
        logger.warn('[Federation] failed to resolve inbound profile link', { error: err });
      }
    }),
  );
}

/**
 * Resolve ONE extracted `Mention` tag to its mentioned actor, or `null` when it
 * cannot be resolved (leaving its anchor as bare text). This is the single seam
 * {@link buildResolvedInboundMentions} varies across its callers: the live inbox
 * path resolves through {@link resolveMentionOxyId} with the fetch-and-create
 * remote resolver, the one-shot repair path resolves lookup-only, and the batched
 * outbox path resolves from a precomputed map with NO further I/O.
 */
type MentionTagResolver = (tag: InboundMentionTag) => Promise<MentionActorResolution | null>;

/**
 * Shared engine behind {@link resolveInboundMentions},
 * {@link resolveInboundMentionsExisting} and {@link resolveInboundMentionsForNotes}:
 * extract the `Mention` tags, resolve each DISTINCT actor href AT MOST once (no
 * N+1), and build the id/localId sets plus the candidate-anchor map. Fail-soft per
 * mention (a tag that fails to resolve is simply absent, leaving its anchor as bare
 * text). The ONLY behavioural difference between the callers is `resolveTag` —
 * whether an unknown remote actor is fetched-and-created, looked up read-only, or
 * read from a precomputed batch map — so all cover the exact same set of anchor
 * href forms.
 *
 * The tag pass is followed by {@link addContentProfileMentions}, which picks up
 * the profile links no tag claimed. That pass is lookup-only on every caller, so
 * it needs no seam of its own.
 */
async function buildResolvedInboundMentions(
  object: Record<string, unknown>,
  resolveTag: MentionTagResolver,
): Promise<ResolvedInboundMentions> {
  const anchorMap = new Map<string, string>();
  const ids = new Set<string>();
  const localIds = new Set<string>();

  const tags = extractMentionTags(object);
  if (tags.length > 0) {
    // Dedupe by actor href so a user mentioned twice is resolved once.
    const byHref = new Map<string, InboundMentionTag>();
    for (const tag of tags) {
      if (!byHref.has(tag.href)) byHref.set(tag.href, tag);
    }

    await Promise.all(
      [...byHref.values()].map(async (tag) => {
        try {
          const resolved = await resolveTag(tag);
          if (!resolved) return;
          ids.add(resolved.oxyUserId);
          if (resolved.isLocal) localIds.add(resolved.oxyUserId);
          // Map every candidate anchor href to this id so the content anchor
          // matches regardless of which form the origin server used: the actor URI
          // (Pleroma / our own posts), the reconstructed `https://<domain>/@<user>`
          // profile URL (Mastodon/Misskey), and — for a bridged Bluesky mention —
          // the `https://bsky.app/profile/<did|handle>` web-profile forms Bridgy Fed
          // uses in-content.
          anchorMap.set(normalizeActorHref(tag.href), resolved.oxyUserId);
          for (const profileHref of reconstructProfileHrefs(tag)) {
            anchorMap.set(normalizeActorHref(profileHref), resolved.oxyUserId);
          }
          for (const bridged of bridgedMentionAnchorHrefs(tag)) {
            anchorMap.set(normalizeActorHref(bridged), resolved.oxyUserId);
          }
        } catch (err) {
          logger.warn('[Federation] failed to resolve inbound mention', { error: err });
        }
      }),
    );
  }

  await addContentProfileMentions(object, { ids, localIds, anchorMap });

  return { ids: [...ids], localIds: [...localIds], anchorMap };
}

/**
 * Resolve every `Mention` tag on an inbound Note to its Oxy user id, batched (each
 * distinct actor href is resolved AT MOST once — no N+1). Fail-soft per mention: a
 * tag that fails to resolve is simply absent from the result, leaving its anchor as
 * bare text. A Note with no `Mention` tags still goes through the lookup-only
 * profile-link pass ({@link addContentProfileMentions}).
 *
 * This is the LIVE inbox path: an unknown remote actor is fetched-and-synced (a
 * `FederatedActor` row is created) so a first-seen mention still links. For the
 * one-shot repair use {@link resolveInboundMentionsExisting}, which never fetches
 * or creates an actor.
 */
export async function resolveInboundMentions(
  object: Record<string, unknown>,
): Promise<ResolvedInboundMentions> {
  return buildResolvedInboundMentions(object, (tag) =>
    resolveMentionOxyId(tag.href, fetchOrCreateRemoteActorOxyId),
  );
}

/**
 * Lookup-only variant of {@link resolveInboundMentions} for the one-shot repair
 * path: resolve each mention against ALREADY-KNOWN identities only — local Oxy
 * users and EXISTING `FederatedActor` rows — and NEVER fetch or create a remote
 * actor. A mentioned actor that is not already stored is SKIPPED (its anchor is
 * left as raw text), which is strictly better than minting a 0-post ghost
 * federated actor for every account a legacy post happened to mention (deleted or
 * spam Mastodon accounts that now 410 Gone included). Same
 * {@link ResolvedInboundMentions} shape and same anchor-form coverage as the live
 * path — the create-vs-lookup choice is the only difference.
 */
export async function resolveInboundMentionsExisting(
  object: Record<string, unknown>,
): Promise<ResolvedInboundMentions> {
  return buildResolvedInboundMentions(object, (tag) =>
    resolveMentionOxyId(tag.href, lookupExistingRemoteActorOxyId),
  );
}

/** Tuning for {@link resolveInboundMentionsForNotes}'s bounded remote fan-out. */
export interface BatchMentionResolveOptions {
  /** Max distinct mention actors resolved in parallel per batch. */
  concurrency: number;
  /**
   * Per-actor wall-clock budget. A remote actor fetch that exceeds it resolves to
   * "unresolved" (its anchor stays bare text) rather than stalling the batch.
   */
  perActorTimeoutMs: number;
}

/**
 * Batched, BOUNDED variant of {@link resolveInboundMentions} for the outbox
 * backfill path, which imports a whole PAGE of Notes in one pass. Returns each
 * note's {@link ResolvedInboundMentions}, keyed by the input object reference.
 *
 * The outbox path must resolve the UNION of the page's @mentions without either
 * (a) re-resolving an actor several notes mention, or (b) fanning out one
 * UNBOUNDED remote actor fetch per mention across the page — the exact failure
 * mode that once hung a Bluesky re-ingest. So every DISTINCT mention actor across
 * all notes is resolved AT MOST once, in batches of `concurrency`, each remote
 * resolution capped by `perActorTimeoutMs`; a slow/dead/throwing actor yields
 * `null` and its anchor stays bare text instead of stalling or aborting the page.
 *
 * Like {@link resolveInboundMentions} (and unlike the repair path), a first-seen
 * mentioned actor IS fetched-and-created so its mention links. The per-note
 * placeholder/id assembly then runs against the shared resolution map with no
 * further TAG I/O, reusing the identical anchor-matching logic as the single-note
 * paths via {@link buildResolvedInboundMentions} — including its profile-link
 * pass, whose per-note lookups are indexed, capped by
 * {@link MAX_CONTENT_PROFILE_LINKS}, and never a remote fetch.
 */
export async function resolveInboundMentionsForNotes(
  objects: ReadonlyArray<Record<string, unknown>>,
  options: BatchMentionResolveOptions,
): Promise<Map<Record<string, unknown>, ResolvedInboundMentions>> {
  const byNote = new Map<Record<string, unknown>, ResolvedInboundMentions>();
  if (objects.length === 0) return byNote;

  // 1. Union of DISTINCT mention actor hrefs across every note in the page.
  const distinctHrefs = new Set<string>();
  for (const object of objects) {
    for (const tag of extractMentionTags(object)) distinctHrefs.add(tag.href);
  }

  // 2. Resolve each distinct href AT MOST once (fetch-and-create) in bounded
  //    batches, each capped by the per-actor timeout. A timeout, a null, or a
  //    thrown error leaves the href unresolved — never aborts the batch.
  const resolutions = new Map<string, MentionActorResolution>();
  const hrefs = [...distinctHrefs];
  const concurrency = Math.max(1, options.concurrency);
  for (let i = 0; i < hrefs.length; i += concurrency) {
    const batch = hrefs.slice(i, i + concurrency);
    const resolved = await Promise.all(
      batch.map((href) =>
        runWithTimeout(
          resolveMentionOxyId(href, fetchOrCreateRemoteActorOxyId),
          options.perActorTimeoutMs,
        ).catch((err) => {
          logger.warn('[Federation] failed to resolve outbox mention', { error: err });
          return null;
        }),
      ),
    );
    for (let j = 0; j < batch.length; j++) {
      const value = resolved[j];
      if (value) resolutions.set(batch[j], value);
    }
  }

  // 3. Assemble each note's placeholders/ids from the shared map — NO I/O, same
  //    anchor-matching engine as the single-note paths.
  for (const object of objects) {
    byNote.set(
      object,
      await buildResolvedInboundMentions(object, (tag) =>
        Promise.resolve(resolutions.get(tag.href) ?? null),
      ),
    );
  }
  return byNote;
}

/**
 * Replace every in-content mention anchor whose `href` matches a resolved mention
 * with the internal `[mention:<oxyUserId>]` placeholder. Anchors that match no
 * resolved mention (hashtag anchors, bare links, an unresolved mention) are left
 * untouched — {@link htmlToPlainText} handles those downstream. Pure.
 */
export function rewriteMentionAnchors(
  html: string,
  anchorMap: ReadonlyMap<string, string>,
): string {
  if (!html || anchorMap.size === 0) return html;
  return html.replace(MENTION_ANCHOR_REGEX, (match, href: string) => {
    const oxyUserId = anchorMap.get(normalizeActorHref(href));
    return oxyUserId ? `[mention:${oxyUserId}]` : match;
  });
}

/**
 * Return a shallow copy of an AP Note object whose HTML bodies (`content` and every
 * `contentMap` variant) have had their mention anchors rewritten to
 * `[mention:<id>]` placeholders. The original object is never mutated; when the
 * anchor map is empty the object is returned unchanged (zero cost for the common
 * no-mention case). Every body is rewritten with the SAME map so the primary body
 * and its `contentMap` counterpart stay byte-consistent for the language extractor.
 */
export function applyMentionPlaceholders(
  object: Record<string, unknown>,
  anchorMap: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (anchorMap.size === 0) return object;

  const rewritten: Record<string, unknown> = { ...object };
  if (typeof object.content === 'string') {
    rewritten.content = rewriteMentionAnchors(object.content, anchorMap);
  }

  const contentMap = getApContentMap(object);
  if (contentMap) {
    const rewrittenMap: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(contentMap)) {
      rewrittenMap[key] = typeof value === 'string' ? rewriteMentionAnchors(value, anchorMap) : value;
    }
    rewritten.contentMap = rewrittenMap;
  }

  return rewritten;
}
