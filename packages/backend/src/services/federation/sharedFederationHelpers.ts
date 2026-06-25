import mongoose from 'mongoose';
import { logger } from '../../utils/logger';
import { Post } from '../../models/Post';
import { signRequest, getPublicKey } from '../../utils/federation/crypto';
import {
  AP_CONTENT_TYPE,
  USER_AGENT,
  extractLocalPostIdFromApUri,
} from '../../utils/federation/constants';
import { PostVisibility } from '@mention/shared-types';
import { extractApMediaFromNote, type ApMediaType } from '../../utils/federation/apMedia';
import { normalizeHashtag } from '../../utils/textProcessing';
import { recordAccessAndMaybeEnqueue } from '../mediaCache/cacheStore';
import { assertSafePublicUrl } from '../../utils/ssrfGuard';
import { persistRemoteMediaForFederatedOwnerDetailed } from '../mediaCache/cacheWorker';

/**
 * Shared low-level helpers used by more than one federation sub-service
 * (ActorService, OutboxSyncService, InboxProcessingService, FollowService).
 *
 * These were previously private members / module-level functions of the
 * monolithic FederationService. They are extracted here verbatim — same
 * behavior, same signatures — so the sub-services can depend on a single
 * cohesive low-level module instead of reaching into each other.
 */

export type ExtractedMediaItem = { id: string; type: ApMediaType };
export type ExtractedMediaAttachment = { type: 'media'; id: string; mediaType: ApMediaType };

const SIGNED_FETCH_TIMEOUT_MS = 10000;

export function isAbsoluteHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

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

export function getRemoteHost(remoteUrl: string): string | undefined {
  try {
    return new URL(remoteUrl).host.toLowerCase();
  } catch {
    return undefined;
  }
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
 * Sign a GET request using the instance actor key pair (managed by Oxy).
 * Required by servers that enforce authorized fetch (e.g., Threads).
 */

function requestInitHeaders(init: RequestInit): Record<string, string> {
  if (!init.headers) return {};
  if (init.headers instanceof Headers) return Object.fromEntries(init.headers.entries());
  if (Array.isArray(init.headers)) return Object.fromEntries(init.headers);
  return init.headers as Record<string, string>;
}

export async function signedFetch(url: string, accept: string, init: RequestInit = {}): Promise<Response> {
  const acceptHeader = `${accept}, application/ld+json; profile="https://www.w3.org/ns/activitystreams"`;
  const { keyId } = await getPublicKey('instance');
  const sigHeaders = await signRequest(keyId, 'GET', url);
  const extraHeaders = requestInitHeaders(init);

  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: acceptHeader,
      'User-Agent': USER_AGENT,
      ...sigHeaders,
      ...extraHeaders,
    },
    signal: init.signal ?? AbortSignal.timeout(SIGNED_FETCH_TIMEOUT_MS),
  });

  // If the remote server returns a 5xx (e.g. it can't resolve our keyId to verify
  // the signature), retry without the signature as a fallback for public resources.
  if (res.status >= 500) {
    logger.info(`[FedSync] signedFetch got ${res.status} for ${url}, retrying unsigned`);
    return fetch(url, {
      ...init,
      headers: {
        Accept: acceptHeader,
        'User-Agent': USER_AGENT,
        ...extraHeaders,
      },
      signal: init.signal ?? AbortSignal.timeout(SIGNED_FETCH_TIMEOUT_MS),
    });
  }

  // A 401/403 on a signed request means the remote rejected OUR signature
  // (e.g. it could not resolve/verify our keyId, or our instance key pair is
  // missing/invalid because the service token could not be acquired). Without a
  // log this silently yields zero results — surface it so the failure mode is
  // observable in production. The caller still receives the response and decides
  // how to proceed; we do not change control flow here.
  if (res.status === 401 || res.status === 403) {
    logger.warn(
      `[FedSync] signedFetch got ${res.status} ${res.statusText} for ${url} — remote rejected our HTTP signature (check instance key pair / service token); returning the failed response so no posts are imported from this source`,
    );
  }

  return res;
}


const REDIRECT_STATUS_CODES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const MAX_ACTIVITYPUB_REDIRECTS = 3;

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
 * Extract media attachments from an AP Note object.
 * Returns media items and attachment descriptors for the Post model.
 *
 * Delegates to `extractApMediaFromNote`, which normalizes the many fediverse
 * attachment shapes (Mastodon string `url`, Pleroma `Link` object, PeerTube/Lemmy
 * array of `Link` objects) and picks the most broadly-playable video variant.
 */
export function extractApMedia(note: Record<string, any>): {
  media: Array<{ id: string; type: ApMediaType }>;
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

/**
 * Persist remote media to Oxy S3 (when an owner is known), rewriting media ids
 * to the cached Oxy file ids. Permanently-unavailable remote media is dropped
 * from both the media list and matching attachments; soft failures keep the
 * original remote URL and queue it for a later cache attempt.
 */
export async function materializeFederatedMedia(
  media: ExtractedMediaItem[],
  attachments: ExtractedMediaAttachment[],
  ownerOxyUserId: string | null | undefined,
  context: { activityId?: string; actorUri?: string } = {},
): Promise<{ media: ExtractedMediaItem[]; attachments: ExtractedMediaAttachment[] }> {
  if (media.length === 0) return { media, attachments };

  const idMap = new Map<string, string>();
  const removedRemoteUrls = new Set<string>();
  const outputMedia: ExtractedMediaItem[] = [];

  for (const item of media) {
    const remoteUrl = item.id;
    if (!isAbsoluteHttpUrl(remoteUrl)) {
      outputMedia.push(item);
      continue;
    }

    if (!ownerOxyUserId) {
      void recordAccessAndMaybeEnqueue(remoteUrl);
      outputMedia.push(item);
      continue;
    }

    const persistedResult = await persistRemoteMediaForFederatedOwnerDetailed(remoteUrl, ownerOxyUserId, {
      remoteHost: getRemoteHost(remoteUrl),
      activityId: context.activityId,
      actorUri: context.actorUri,
      mediaType: item.type,
    });

    if (!persistedResult.ok) {
      if (persistedResult.permanent) {
        logger.info('[Federation] Dropping permanently unavailable remote media', {
          remoteHost: getRemoteHost(remoteUrl),
          status: persistedResult.status,
          activityId: context.activityId,
        });
        removedRemoteUrls.add(remoteUrl);
        continue;
      }
      void recordAccessAndMaybeEnqueue(remoteUrl);
      outputMedia.push(item);
      continue;
    }

    const persisted = persistedResult.media;
    idMap.set(remoteUrl, persisted.oxyFileId);
    outputMedia.push({
      ...item,
      id: persisted.oxyFileId,
      remoteUrl,
      cachedFromFederation: true,
      ...(persisted.posterFileId ? { posterFileId: persisted.posterFileId } : {}),
    } as ExtractedMediaItem);
  }

  if (idMap.size === 0 && removedRemoteUrls.size === 0) return { media: outputMedia, attachments };

  const outputAttachments = attachments
    .filter((attachment) => !removedRemoteUrls.has(attachment.id))
    .map((attachment) => ({
      ...attachment,
      id: idMap.get(attachment.id) || attachment.id,
    }));

  return { media: outputMedia, attachments: outputAttachments };
}
