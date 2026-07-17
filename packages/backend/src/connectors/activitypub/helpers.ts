import mongoose from 'mongoose';
import { logger } from '../../utils/logger';
import { Post } from '../../models/Post';
import { createSignedFetch, type SignedFetch } from '@oxyhq/federation/node';
import { getPublicKey, signViaOxy } from './crypto';
import {
  AP_CONTENT_TYPE,
  USER_AGENT,
  extractLocalPostIdFromApUri,
} from './constants';
import { PostVisibility, type MediaItem } from '@mention/shared-types';
import { extractApMediaFromNote, type ApMediaType } from './apMedia';
import { normalizeHashtag } from '../../utils/textProcessing';
import { assertSafePublicUrl } from '@oxyhq/core/server';
import { fetchUpstreamSingleHop, type SingleHopResult } from '../../utils/safeUpstreamFetch';
import { isAbsoluteHttpUrl } from '../shared/url';

/**
 * Low-level ActivityPub helpers used by more than one AP sub-service
 * (actor / follow / inbox / outbox services).
 *
 * These were previously the AP-specific members of the monolithic federation
 * helpers. They are kept here — verbatim, same behavior, same signatures — so
 * the AP sub-services depend on a single cohesive low-level module. The
 * protocol-agnostic media materializer and the generic URL predicates were
 * split out to `connectors/shared/federatedMedia.ts` and
 * `connectors/shared/url.ts` respectively.
 */

/** Bounded redirect budget for the stricter boost-import fetch; each hop re-validated. */
const MAX_ACTIVITYPUB_REDIRECTS = 3;
const REDIRECT_STATUS_CODES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

export function activityPubItems(value: Record<string, any>): unknown[] {
  if (Array.isArray(value.orderedItems)) return value.orderedItems;
  if (Array.isArray(value.items)) return value.items;
  return [];
}

export function activityPubLinkUrl(value: unknown): string | null {
  if (typeof value === 'string' && isAbsoluteHttpUrl(value)) return value;
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.id === 'string' && isAbsoluteHttpUrl(record.id)) return record.id;
  if (typeof record.href === 'string' && isAbsoluteHttpUrl(record.href)) return record.href;
  return null;
}

export function firstStringUrl(value: unknown): string | undefined {
  if (typeof value === 'string' && isAbsoluteHttpUrl(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const resolved = firstStringUrl(item);
      if (resolved) return resolved;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return firstStringUrl(record.url) || firstStringUrl(record.href);
  }
  return undefined;
}

/**
 * Tolerance window for a federated post's `published` date being slightly ahead
 * of our clock. A small skew between instances is normal; anything beyond this
 * is treated as a bogus future date and rejected (fall back to now).
 */
const AP_PUBLISHED_MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Parse an ActivityPub `published` value (ISO 8601, e.g. `"2023-04-01T12:00:00Z"`)
 * into a `Date` suitable for use as a federated post's `createdAt`.
 *
 * Returns `undefined` — so callers fall back to the schema's default timestamp
 * (now) — when the value is missing, not a string, unparseable, or implausibly
 * far in the future. Used by BOTH federation ingest paths (inbox `handleCreate`
 * and outbox backfill / boost import) so a federated post always reflects its
 * ORIGINAL remote publish date rather than our sync time.
 */
export function parseApPublished(published: unknown): Date | undefined {
  if (typeof published !== 'string') return undefined;
  const trimmed = published.trim();
  if (!trimmed) return undefined;

  const parsed = new Date(trimmed);
  const ms = parsed.getTime();
  if (Number.isNaN(ms)) return undefined;

  // Reject clearly-bogus future timestamps so a misconfigured remote can't
  // push a post permanently to the top of time-ordered feeds.
  if (ms > Date.now() + AP_PUBLISHED_MAX_FUTURE_SKEW_MS) return undefined;

  return parsed;
}

export function normalizeFederatedAcct(acct: string | undefined): string | undefined {
  if (!acct) return undefined;
  const cleaned = acct.trim().replace(/^acct:/i, '').replace(/^@/, '');
  const atIndex = cleaned.indexOf('@');
  if (atIndex <= 0 || atIndex === cleaned.length - 1) return undefined;

  const localPart = cleaned.substring(0, atIndex).toLowerCase();
  const domain = cleaned.substring(atIndex + 1).toLowerCase();
  if (!localPart || !domain) return undefined;

  return `${localPart}@${domain}`;
}

export function domainFromAcct(acct: string): string | undefined {
  const atIndex = acct.indexOf('@');
  if (atIndex === -1 || atIndex === acct.length - 1) return undefined;
  return acct.substring(atIndex + 1).toLowerCase();
}

/**
 * Adapt the Node `IncomingMessage` stream returned by {@link fetchUpstreamSingleHop}
 * into a WHATWG `Response`, so every `signedFetch` caller keeps using the
 * standard `Response` surface (`.ok`, `.status`, `.statusText`, `.headers.get()`,
 * `.json()`, `.text()`) unchanged.
 *
 * The body is buffered eagerly. This is acceptable here because every signed
 * federation fetch reads a single (bounded) ActivityPub JSON document — actor,
 * outbox/page collection, or a Note/Article — never a large media stream (media
 * goes through `/media/proxy`, which streams the `IncomingMessage` directly).
 * Redirect responses carry no body of interest, so their stream is destroyed.
 */
async function singleHopToResponse(result: SingleHopResult): Promise<Response> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(result.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  // A 204/205/304 (and 3xx redirects) must not carry a body per the fetch spec.
  // For a redirect we only need the `location` header (already captured above),
  // so destroy the stream rather than draining a potentially unbounded body.
  const isRedirect = REDIRECT_STATUS_CODES.has(result.status);
  const nullBodyStatus = result.status === 204 || result.status === 205 || result.status === 304 || isRedirect;
  if (nullBodyStatus) {
    result.response.destroy();
    return new Response(null, { status: result.status, headers });
  }

  const chunks: Buffer[] = [];
  for await (const chunk of result.response) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new Response(Buffer.concat(chunks), { status: result.status, headers });
}

/** Resolve the Oxy-managed instance actor's keyId used to sign outbound AP GETs. */
async function getInstanceKeyId(): Promise<string> {
  const { keyId } = await getPublicKey('instance');
  return keyId;
}

// Built lazily on first use so the adapters (`signViaOxy`, `USER_AGENT`) are read
// at call time — NOT at module import — matching the original `signedFetch`'s
// call-time evaluation (a module never reads federation credentials just to load).
let signedFetchImpl: SignedFetch | null = null;
function getSignedFetch(): SignedFetch {
  if (!signedFetchImpl) {
    signedFetchImpl = createSignedFetch({
      sign: signViaOxy,
      getInstanceKeyId,
      fetchSingleHop: (url, init) =>
        fetchUpstreamSingleHop(url, {
          headers: init.headers,
          signal: init.signal,
          headersTimeoutMs: init.headersTimeoutMs,
        }).then(singleHopToResponse),
      userAgent: USER_AGENT,
      logger: {
        info: (message) => logger.info(message),
        warn: (message) => logger.warn(message),
      },
    });
  }
  return signedFetchImpl;
}

/**
 * Sign a GET request using the instance actor key pair (managed by Oxy) and
 * perform it under the SSRF-safe contract.
 *
 * The signing + per-hop re-signing redirect policy lives in `@oxyhq/federation`
 * (`createSignedFetch`); Mention supplies the private-key custody (`signViaOxy`,
 * which calls oxy-api — the key never enters Mention), the instance keyId, and
 * the SSRF-safe single-hop transport ({@link fetchUpstreamSingleHop}, which
 * validates the URL AND pins the TCP connection to the validated IP via a custom
 * DNS `lookup` — DNS is NOT re-resolved at connect time, closing the DNS-rebind
 * TOCTOU window). The engine re-validates AND re-signs each redirect hop, honours
 * `init.redirect === 'manual'` (returning the redirect for a stricter per-hop
 * policy — see {@link fetchVerifiedAnnouncedNote}), and retries unsigned on a 5xx
 * for public resources.
 */
export function signedFetch(url: string, accept: string, init: RequestInit = {}): Promise<Response> {
  return getSignedFetch()(url, accept, init);
}

function sameOrigin(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.protocol === b.protocol && a.host.toLowerCase() === b.host.toLowerCase();
  } catch {
    return false;
  }
}

function isPubliclyAddressed(to?: unknown, cc?: unknown): boolean {
  const addressees = [
    ...(Array.isArray(to) ? to : []),
    ...(Array.isArray(cc) ? cc : []),
  ];
  return addressees.includes('https://www.w3.org/ns/activitystreams#Public');
}

export interface FetchedAnnouncedNote {
  note: Record<string, any>;
  finalUrl: string;
}

/**
 * Fetch an announced Note/Article under the stricter boost-import contract:
 * every hop must be a public http(s) URL, redirects are re-validated, the final
 * object id must match the fetched IRI, the author must share the object's
 * origin, and only public notes are importable as public boost originals.
 */
export async function fetchVerifiedAnnouncedNote(objectUri: string): Promise<FetchedAnnouncedNote | null> {
  let currentUrl = objectUri;

  for (let hop = 0; hop <= MAX_ACTIVITYPUB_REDIRECTS; hop++) {
    const guard = await assertSafePublicUrl(currentUrl);
    if (!guard.ok) {
      logger.info(`[FedSync] blocked boosted object fetch ${currentUrl}: ${guard.reason}`);
      return null;
    }

    let res: Response;
    try {
      res = await signedFetch(currentUrl, AP_CONTENT_TYPE, { redirect: 'manual' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.info(`[FedSync] error fetching boosted object ${currentUrl}: ${message}`);
      return null;
    }

    if (REDIRECT_STATUS_CODES.has(res.status)) {
      const location = res.headers.get('location');
      if (hop === MAX_ACTIVITYPUB_REDIRECTS || !location) {
        logger.info(`[FedSync] boosted object ${currentUrl} redirect failed`);
        return null;
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    if (!res.ok) {
      logger.info(`[FedSync] failed to fetch boosted object ${currentUrl}: ${res.status} ${res.statusText}`);
      return null;
    }

    let note: Record<string, any>;
    try {
      note = await res.json() as Record<string, any>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.info(`[FedSync] failed to parse boosted object ${currentUrl}: ${message}`);
      return null;
    }

    if (!note || (note.type !== 'Note' && note.type !== 'Article')) return null;

    const noteId = typeof note.id === 'string' ? note.id : undefined;
    if (!noteId || !sameOrigin(noteId, currentUrl)) {
      logger.info(`[FedSync] boosted object ${currentUrl} id is missing or not same-origin; skipping`);
      return null;
    }

    const authorUri = extractActorUri(note.attributedTo);
    if (!authorUri || !sameOrigin(authorUri, noteId)) {
      logger.info(`[FedSync] boosted object ${noteId} attributedTo is missing or not same-origin; skipping`);
      return null;
    }

    if (!isPubliclyAddressed(note.to, note.cc)) {
      logger.info(`[FedSync] boosted object ${noteId} is not public; skipping boost import`);
      return null;
    }

    return { note, finalUrl: currentUrl };
  }

  return null;
}

/**
 * Fetch and parse a remote ActivityPub object via `signedFetch`. Returns null
 * on any HTTP/parse failure.
 */
export async function fetchActivityPubObject(url: string): Promise<Record<string, any> | null> {
  try {
    const res = await signedFetch(url, AP_CONTENT_TYPE);
    if (!res.ok) {
      logger.info(`[FedSync] ActivityPub object fetch failed: ${res.status} ${res.statusText} for ${url}`);
      return null;
    }
    const object = await res.json();
    return asRecord(object);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.info(`[FedSync] ActivityPub object fetch error for ${url}: ${message}`);
    return null;
  }
}

/**
 * Race a promise against a wall-clock deadline. Resolves to `null` if the
 * deadline elapses first, so a single hung remote operation can't stall a
 * batch. The underlying work is not aborted (callers here are read-only and
 * idempotent); it is simply abandoned for result purposes.
 */
export async function runWithTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Whether an error is a MongoDB duplicate-key error (code 11000), including
 * Mongoose `MongoServerError` and bulk write error shapes.
 */
export function isDuplicateKeyError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    return (err as { code?: unknown }).code === 11000;
  }
  return false;
}

/**
 * Extract the announced object URI from an Announce activity's `object`,
 * which may be a plain URI string or an embedded object with an `id`.
 */
export function extractAnnouncedObjectUri(object: unknown): string | undefined {
  if (typeof object === 'string') return isAbsoluteHttpUrl(object) ? object : undefined;
  if (object && typeof object === 'object' && 'id' in object) {
    const id = (object as { id?: unknown }).id;
    return typeof id === 'string' && isAbsoluteHttpUrl(id) ? id : undefined;
  }
  return undefined;
}

/**
 * Extract the actor URI from an AP attributedTo value,
 * which may be a plain URI string or an object with an id property.
 */
export function extractActorUri(attributedTo: unknown): string | undefined {
  if (typeof attributedTo === 'string') return attributedTo;
  if (attributedTo && typeof attributedTo === 'object' && 'id' in attributedTo) {
    return (attributedTo as { id?: string }).id;
  }
  return undefined;
}

/**
 * Extract the parent object URI from an AP `inReplyTo` value.
 *
 * `inReplyTo` is usually a plain IRI string, but some servers (Pleroma,
 * PeerTube) emit an embedded `Link`/object carrying `id` or `href`. This
 * normalizes both shapes to a single trimmed string URI (or `undefined` when
 * absent/empty), so the value persisted in `federation.inReplyTo` is always a
 * resolvable string — never a stringified `[object Object]` — and is usable
 * directly by {@link resolvePostIdFromObjectUri} for thread linking.
 */
export function extractInReplyToUri(inReplyTo: unknown): string | undefined {
  if (typeof inReplyTo === 'string') {
    const trimmed = inReplyTo.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (inReplyTo && typeof inReplyTo === 'object') {
    const record = inReplyTo as { id?: unknown; href?: unknown };
    if (typeof record.id === 'string' && record.id.trim().length > 0) return record.id.trim();
    if (typeof record.href === 'string' && record.href.trim().length > 0) return record.href.trim();
  }
  return undefined;
}

/**
 * Extract the canonical AP object URI of the post a Note QUOTES, or `undefined`
 * when it quotes nothing.
 *
 * A quote is advertised across several interoperating terms — the SAME set the
 * outbound Note builder emits ({@link FollowService.buildCreateNoteActivity}): the
 * modern `quote`/`quoteUri` (FEP-044f / Mastodon 4.4+), the legacy
 * `_misskey_quote`/`quoteUrl` (Misskey/Pleroma/Akkoma), and the FEP-e232 `Link`
 * quote tag (`rel: …#_misskey_quote` and/or `mediaType: application/activity+json`).
 * Bridgy Fed publishes a bridged Bluesky quote through these same fields, pointing
 * at the quoted post's wrapped brid.gy object URL
 * (`https://bsky.brid.gy/convert/ap/at://…`).
 *
 * The structured fields win over the tag; each candidate is normalized through
 * {@link activityPubLinkUrl} (string / `{id}` / `{href}`) and must be an absolute
 * http(s) URL. Pure / no I/O — the caller resolves the URI to a local Post via
 * {@link resolvePostIdFromObjectUri}.
 */
export function extractApQuoteUri(object: Record<string, unknown>): string | undefined {
  for (const key of ['quote', 'quoteUri', 'quoteUrl', '_misskey_quote'] as const) {
    const uri = activityPubLinkUrl(object[key]);
    if (uri) return uri;
  }

  const tags = object.tag;
  if (Array.isArray(tags)) {
    for (const entry of tags) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as { type?: unknown; rel?: unknown; mediaType?: unknown; href?: unknown };
      const isLink =
        record.type === 'Link' || (Array.isArray(record.type) && record.type.includes('Link'));
      if (!isLink) continue;

      const rel = Array.isArray(record.rel)
        ? record.rel.join(' ')
        : typeof record.rel === 'string'
          ? record.rel
          : '';
      const isQuoteRel = rel.includes('_misskey_quote');
      const isApLink =
        typeof record.mediaType === 'string' && record.mediaType.toLowerCase().includes('activity+json');
      if (!isQuoteRel && !isApLink) continue;

      const href = typeof record.href === 'string' ? record.href.trim() : '';
      if (href && isAbsoluteHttpUrl(href)) return href;
    }
  }

  return undefined;
}

/**
 * Extract media attachments from an AP Note object.
 * Returns media items and attachment descriptors for the Post model.
 *
 * Delegates to `extractApMediaFromNote`, which normalizes the many fediverse
 * attachment shapes (Mastodon string `url`, Pleroma `Link` object, PeerTube/Lemmy
 * array of `Link` objects) and picks the most broadly-playable video variant.
 */
export function extractApMedia(note: Record<string, any>): {
  media: MediaItem[];
  attachments: Array<{ type: 'media'; id: string; mediaType: ApMediaType }>;
} {
  return extractApMediaFromNote(note);
}

/**
 * Extract hashtags from an AP Note's tag array.
 *
 * Tags are stored canonically lowercased (and trimmed) so federated content
 * matches the case-insensitive read paths used by the hashtag screen, MTN
 * `HashtagFeed`, and the trending aggregations. Entries that are empty after
 * stripping the leading `#` are skipped.
 */
export function extractApHashtags(note: Record<string, any>): string[] {
  const hashtags: string[] = [];
  if (!Array.isArray(note.tag)) return hashtags;

  for (const tag of note.tag) {
    if (tag?.type === 'Hashtag' && tag.name) {
      const normalized = normalizeHashtag(tag.name);
      if (normalized.length > 0) {
        hashtags.push(normalized);
      }
    }
  }
  return hashtags;
}

/**
 * Map ActivityPub to/cc addressing to Mention visibility.
 */
export function mapApVisibility(to?: string[], cc?: string[]): PostVisibility {
  const allAddressees = [...(to || []), ...(cc || [])];
  if (allAddressees.includes('https://www.w3.org/ns/activitystreams#Public')) {
    return PostVisibility.PUBLIC;
  }
  return PostVisibility.FOLLOWERS_ONLY;
}

/**
 * Resolve an ActivityPub object URI to a local Post `_id`, handling both:
 *  - a local post (our own AP note URI → `<...>/posts/<postId>`), and
 *  - an imported federated post (matched by `federation.activityId`).
 *
 * Returns the Post `_id` as a string, or null when no such post exists here.
 */
export async function resolvePostIdFromObjectUri(objectUri: string): Promise<string | null> {
  const localPostId = extractLocalPostIdFromApUri(objectUri);
  if (localPostId && mongoose.Types.ObjectId.isValid(localPostId)) {
    const local = await Post.findOne({
      _id: localPostId,
      status: 'published',
      visibility: PostVisibility.PUBLIC,
    }, { _id: 1 }).lean();
    if (local) return String(local._id);
  }

  const imported = await Post.findOne(
    { 'federation.activityId': objectUri },
    { _id: 1 },
  ).lean();
  return imported ? String(imported._id) : null;
}
