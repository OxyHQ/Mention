import { and, eq, sql, type SQL } from 'drizzle-orm';
import { logger } from '../../utils/logger';
import { getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
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
import { clampFutureDate } from '../../utils/ingestTimestamp';
import { assertSafePublicUrl } from '@oxyhq/core/server';
import { fetchUpstreamSingleHop, type SingleHopResult } from '../../utils/safeUpstreamFetch';
import { isAbsoluteHttpUrl, getRemoteHost } from '../shared/url';

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
/** Maximum buffered ActivityPub JSON document size (2 MiB). */
export const ACTIVITYPUB_JSON_MAX_BYTES = 2 * 1024 * 1024;
/** Wall-clock budget for signing, redirects, headers, and body. */
export const ACTIVITYPUB_FETCH_DEADLINE_MS = 15_000;
/** Maximum silence between ActivityPub response-body chunks. */
export const ACTIVITYPUB_BODY_IDLE_TIMEOUT_MS = 5_000;

/** The media-type family of a `content-type` header: parameters dropped, lowercased. */
function contentTypeFamily(raw: string | null): string {
  return raw?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function activityPubJsonContentType(raw: string | null): boolean {
  const family = contentTypeFamily(raw);
  return family === 'application/json'
    || family === 'application/activity+json'
    || family === 'application/ld+json'
    || (family.startsWith('application/') && family.endsWith('+json'));
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function activityPubItems(value: Record<string, unknown>): unknown[] {
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
 * far in the future (which would otherwise let a misconfigured remote pin a post
 * to the top of time-ordered feeds). Used by BOTH federation ingest paths (inbox
 * `handleCreate` and outbox backfill / boost import) so a federated post always
 * reflects its ORIGINAL remote publish date rather than our sync time.
 *
 * The guard itself is {@link clampFutureDate}, shared with every other ingest
 * path; only the tolerance window is an ActivityPub policy decision.
 */
export function parseApPublished(published: unknown): Date | undefined {
  return clampFutureDate(published, AP_PUBLISHED_MAX_FUTURE_SKEW_MS);
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
export async function singleHopToResponse(result: SingleHopResult): Promise<Response> {
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

  // A successful ActivityPub document must actually be JSON. Error bodies are
  // allowed to be text/html or text/plain because callers still need the HTTP
  // status for retry/tombstone decisions; their bodies remain byte/time bounded.
  if (result.status >= 200 && result.status < 300
      && !activityPubJsonContentType(headers.get('content-type'))) {
    result.response.destroy();
    // NAME the offending media type. Without it the rejection reads only as
    // "not JSON", and every diagnosis of a bulk sweep costs a code change plus a
    // redeploy to find out whether the origin served HTML, an error page, or
    // nothing at all. Only the media-type FAMILY is interpolated (parameters
    // dropped, lowercased, length-capped), so no remote-controlled payload rides
    // into the message.
    const family = contentTypeFamily(headers.get('content-type'));
    throw new Error(
      `ActivityPub response has unsupported content-type: ${family ? family.slice(0, 64) : '(none)'}`,
    );
  }

  const declaredLength = Number(headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > ACTIVITYPUB_JSON_MAX_BYTES) {
    result.response.destroy();
    throw new Error(`ActivityPub response exceeds ${ACTIVITYPUB_JSON_MAX_BYTES} bytes`);
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      result.response.destroy(new Error('ActivityPub response body idle timeout'));
    }, ACTIVITYPUB_BODY_IDLE_TIMEOUT_MS);
    idleTimer.unref?.();
  };

  armIdleTimer();
  try {
    for await (const chunk of result.response) {
      armIdleTimer();
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > ACTIVITYPUB_JSON_MAX_BYTES) {
        result.response.destroy();
        throw new Error(`ActivityPub response exceeds ${ACTIVITYPUB_JSON_MAX_BYTES} bytes`);
      }
      chunks.push(buffer);
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
  return new Response(Buffer.concat(chunks), { status: result.status, headers });
}

/**
 * Run one signed ActivityPub fetch under a total deadline while preserving a
 * caller-provided abort signal. The composed signal reaches the pinned Node
 * request, so a timeout closes the socket instead of merely abandoning a
 * still-running promise.
 */
export async function withActivityPubDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  upstreamSignal?: AbortSignal | null,
): Promise<T> {
  const controller = new AbortController();
  const forwardAbort = () => {
    controller.abort(upstreamSignal?.reason);
  };

  if (upstreamSignal?.aborted) {
    forwardAbort();
  } else {
    upstreamSignal?.addEventListener('abort', forwardAbort, { once: true });
  }

  const deadline = setTimeout(() => {
    controller.abort(new Error('ActivityPub fetch deadline exceeded'));
  }, ACTIVITYPUB_FETCH_DEADLINE_MS);
  deadline.unref?.();

  let stopAbortRace: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectForAbort = () => {
      reject(controller.signal.reason ?? new Error('ActivityPub fetch aborted'));
    };
    if (controller.signal.aborted) {
      rejectForAbort();
      return;
    }
    controller.signal.addEventListener('abort', rejectForAbort, { once: true });
    stopAbortRace = () => controller.signal.removeEventListener('abort', rejectForAbort);
  });

  try {
    // The transport consumes the signal and closes an active socket. Racing the
    // operation as well enforces the wall-clock budget even if signing/key
    // retrieval is the part that stalls and does not consume AbortSignal.
    if (controller.signal.aborted) return await aborted;
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(deadline);
    stopAbortRace?.();
    upstreamSignal?.removeEventListener('abort', forwardAbort);
  }
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
  return withActivityPubDeadline(
    (signal) => getSignedFetch()(url, accept, { ...init, signal }),
    init.signal,
  );
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
  note: Record<string, unknown>;
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
      logger.info('[FedSync] blocked boosted object fetch', {
        result: guard.reason,
      });
      return null;
    }

    let res: Response;
    try {
      res = await signedFetch(currentUrl, AP_CONTENT_TYPE, { redirect: 'manual' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.info('[FedSync] error fetching boosted object', {
        error: message,
      });
      return null;
    }

    if (REDIRECT_STATUS_CODES.has(res.status)) {
      const location = res.headers.get('location');
      if (hop === MAX_ACTIVITYPUB_REDIRECTS || !location) {
        logger.info('[FedSync] boosted object redirect failed');
        return null;
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    if (!res.ok) {
      logger.info('[FedSync] failed to fetch boosted object', {
        status: res.status,
        statusText: res.statusText,
      });
      return null;
    }

    let note: Record<string, unknown>;
    try {
      note = await res.json() as Record<string, unknown>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.info('[FedSync] failed to parse boosted object', {
        error: message,
      });
      return null;
    }

    if (!note || (note.type !== 'Note' && note.type !== 'Article')) return null;

    const noteId = typeof note.id === 'string' ? note.id : undefined;
    if (!noteId || !sameOrigin(noteId, currentUrl)) {
      logger.info('[FedSync] boosted object id is missing or not same-origin; skipping');
      return null;
    }

    const authorUri = extractActorUri(note.attributedTo);
    if (!authorUri || !sameOrigin(authorUri, noteId)) {
      logger.info('[FedSync] boosted object author is missing or not same-origin; skipping');
      return null;
    }

    if (!isPubliclyAddressed(note.to, note.cc)) {
      logger.info('[FedSync] boosted object is not public; skipping boost import');
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
export async function fetchActivityPubObject(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await signedFetch(url, AP_CONTENT_TYPE);
    if (!res.ok) {
      logger.info('[FedSync] ActivityPub object fetch failed', {
        status: res.status,
        statusText: res.statusText,
      });
      return null;
    }
    const object = await res.json();
    return asRecord(object);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.info('[FedSync] ActivityPub object fetch error', {
      error: message,
    });
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
 * The host Threads serves ActivityPub from. Its WEB origin is `www.threads.com`;
 * the two are not interchangeable and only this one carries actors and notes.
 */
const THREADS_AP_HOST = 'threads.net';

/**
 * Extract the URL of the post a THREADS note quotes, or `undefined`.
 *
 * This reads the BODY, which every other quote path in this codebase is
 * forbidden from doing, so the exception is stated in full.
 *
 * The rule exists to stop a quote being inferred from PROSE: `RE: <url>` is how
 * a remote server RENDERS a quote for clients that cannot show one, it is a
 * symptom rather than a source, and matching it would fire on any post that
 * happens to contain those characters. `quotedPostImport.test.ts` pins that and
 * this function does not weaken it — {@link extractApQuoteUri} still refuses the
 * body, and this is a separate, host-gated reader.
 *
 * What it matches is not prose. Threads wraps its quote in its own markup:
 *
 *   <span class="quote-inline">RE: <a href="https://www.threads.com/@u/post/C">…</a></span>
 *
 * A `class` a remote server emits cannot be produced by a person typing, so the
 * false-positive the rule guards against cannot occur here.
 *
 * WHY THREADS NEEDS ITS OWN READER AT ALL — measured against the live server,
 * because inventing an exception on a guess would be exactly the wrong move:
 * a Threads note carries NO structured quote field. On
 * `threads.net/ap/users/17841401260928433/post/18099292307347571` the keys are
 * `id, type, content, published, @context, contentMap, attributedTo, url, to,
 * cc, tag, interactionPolicy`, `tag` is empty, and `extractApQuoteUri` answers
 * `undefined`. The markup above is the only place the reference exists.
 *
 * THE RESULT IS A WEB URL, NOT AN AP ID, and it cannot be turned into one:
 * `https://www.threads.com/…` serves `text/html` even to a signed request with
 * every `Accept` variant (Threads advertises `type="application/activity+json"`
 * on that URL and does not honour it), and the shortcode decodes into a
 * different id space entirely (`DctXTiWCTZz` → 3975936543654753907, against an
 * AP post id of 17903481120483533). So the caller may only resolve it against
 * `posts.federation_url` — see {@link resolvePostIdFromNoteUrl} — and must never
 * hand it to a fetch.
 */
export function extractThreadsQuoteUrl(object: Record<string, unknown>): string | undefined {
  const content = typeof object.content === 'string' ? object.content : '';
  if (!content.includes('quote-inline')) return undefined;

  const match = /<span[^>]*class="[^"]*\bquote-inline\b[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"/i
    .exec(content);
  const href = match?.[1]?.trim();
  if (!href) return undefined;

  const decoded = href.replace(/&amp;/g, '&');
  return isAbsoluteHttpUrl(decoded) ? decoded : undefined;
}

/**
 * The quote a note DECLARES, however its server chose to carry it.
 *
 * One answer for the three ingest paths, so "does this post point at another
 * one" cannot be decided differently depending on which of them imported it —
 * the asymmetry that shipped quotes linked on the inbox and null everywhere else.
 *
 * `fetchable` is the half that matters to the caller: a structured AP id can be
 * fetched and imported when we do not already hold it, and a Threads web URL
 * cannot be (see {@link extractThreadsQuoteUrl}), so it may only be matched
 * against what is already stored.
 */
export function extractDeclaredQuote(
  object: Record<string, unknown>,
  actorUri: string | undefined,
): { uri: string; fetchable: boolean } | undefined {
  const structured = extractApQuoteUri(object);
  if (structured) return { uri: structured, fetchable: true };

  if (actorUri && getRemoteHost(actorUri) === THREADS_AP_HOST) {
    const threads = extractThreadsQuoteUrl(object);
    if (threads) return { uri: threads, fetchable: false };
  }

  return undefined;
}

/**
 * Resolve a DECLARED quote to a local post id, in the one order every ingest
 * path must use.
 *
 * The order is the rule, and it lives here rather than at each call site because
 * "does this post point at another one, and do we have it" must not depend on
 * which path imported the note — that asymmetry is what shipped quotes linked on
 * the inbox and null on both other routes.
 *
 * Each step exists for a case the others miss:
 *   1. by AP id — also covers a quote of a LOCAL post, which no fetch would find;
 *   2. by note URL — the ONLY way a Threads quote can resolve, because Threads
 *      names its quote by `www.threads.com` web URL and that is exactly what
 *      `posts.federation_url` holds;
 *   3. by importing — ONLY when the URI is an AP id. A Threads web URL is never
 *      handed to a fetch: it serves `text/html` even to a signed request.
 *
 * `importQuoted` is a parameter rather than an import so this can sit beside the
 * two resolvers it sequences without depending on the outbox service — the inbox
 * supplies `ensureQuotedNote`, and the ancestor importer supplies its own
 * depth-capped recursion. It also keeps that service's mocked surface unchanged
 * in the five suites that stub it.
 */
export async function resolveDeclaredQuoteTarget(
  declared: { uri: string; fetchable: boolean },
  importQuoted: (uri: string) => Promise<string | null>,
): Promise<string | null> {
  return (
    (await resolvePostIdFromObjectUri(declared.uri))
    ?? (await resolvePostIdFromNoteUrl(declared.uri))
    ?? (declared.fetchable ? await importQuoted(declared.uri) : null)
  );
}

/**
 * Extract media attachments from an AP Note object.
 * Returns media items and attachment descriptors for the Post model.
 *
 * Delegates to `extractApMediaFromNote`, which normalizes the many fediverse
 * attachment shapes (Mastodon string `url`, Pleroma `Link` object, PeerTube/Lemmy
 * array of `Link` objects) and picks the most broadly-playable video variant.
 */
export function extractApMedia(note: Record<string, unknown>): {
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
export function extractApHashtags(note: Record<string, unknown>): string[] {
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
/**
 * `to`/`cc` come straight off remote JSON-LD, so they are `unknown` until the
 * addressee check narrows them — the same narrowing {@link isPubliclyAddressed}
 * already performs.
 */
export function mapApVisibility(to?: unknown, cc?: unknown): PostVisibility {
  return isPubliclyAddressed(to, cc) ? PostVisibility.PUBLIC : PostVisibility.FOLLOWERS_ONLY;
}

/**
 * Resolve an ActivityPub object URI to a local post id, handling both:
 *  - a local post (our own AP note URI → `<...>/posts/<postId>`), and
 *  - an imported federated post (matched by `federation.activityId`).
 *
 * Returns the post id as a string, or null when no such post exists here.
 *
 * ## There is no id-SHAPE guard, and adding one back would be a silent outage
 *
 * This used to gate the local branch on `ObjectId.isValid(localPostId)`. That
 * check was a cheap way to avoid a Mongo CastError, and it is now the opposite
 * of cheap: `posts.id` is `text` holding a 24-char ObjectId hex for pre-cutover
 * rows and a uuid v7 for everything created after, so an ObjectId test rejects
 * every post this instance has made since the cutover.
 *
 * Thirteen call sites hang off this one function — `handleLike`,
 * `handleUndoLike`, `handleAnnounce`, `handleUndoAnnounce`, `handlePollVote`,
 * `handleCreate`'s quote resolution, `importAnnounce`, `resolveThreadLink`,
 * `ensureFederatedReplyLink` — and every one of them treats `null` as "we do not
 * have that post". So the failure would have been: every reply, like, boost and
 * quote the fediverse aimed at one of our own recent posts stops resolving, with
 * no error, no log, and no exception anywhere. A `text` column needs no guard —
 * an id of any shape simply matches no row.
 */
export async function resolvePostIdFromObjectUri(objectUri: string): Promise<string | null> {
  const db = getDb();
  const localPostId = extractLocalPostIdFromApUri(objectUri);
  if (localPostId) {
    const [local] = await db
      .select({ id: posts.id })
      .from(posts)
      .where(and(
        eq(posts.id, localPostId),
        eq(posts.status, 'published'),
        eq(posts.visibility, PostVisibility.PUBLIC),
      ))
      .limit(1);
    if (local) return local.id;
  }

  // Published + public, not merely "imported": this resolves a remote-supplied
  // object URI into a LOCAL post id that then gets referenced as a quote, so an
  // unpublished or non-public post reached through it would be disclosed to the
  // fediverse by the reference alone.
  const [imported] = await db
    .select({ id: posts.id })
    .from(posts)
    .where(
      and(
        eq(posts.federationActivityId, objectUri),
        eq(posts.status, 'published'),
        eq(posts.visibility, PostVisibility.PUBLIC),
      ),
    )
    .limit(1);
  return imported ? imported.id : null;
}

/**
 * Resolve a post by the NOTE URL its origin published, not by its AP id.
 *
 * The sibling {@link resolvePostIdFromObjectUri} matches `federation_activity_id`,
 * which is the right key for every server that names its quote by AP id. Threads
 * does not: the only reference it carries is a `www.threads.com` web URL, which
 * is exactly what `posts.federation_url` stores for a Threads post
 * (`buildFederatedNoteProvenance` puts the Note's `url` there). Matching on that
 * column is therefore the ONLY way a Threads quote can ever resolve, and it is
 * an exact-string match on a value we wrote ourselves — no parsing, no guessing.
 *
 * Same `published` + `public` gate as its sibling, and for the same reason: this
 * turns a remote-supplied string into a local post id that then gets embedded in
 * somebody else's post, so an unpublished or non-public post reached through it
 * would be disclosed by the reference alone. That gate is also what keeps an
 * `incomplete` post from being quoted while it is withheld.
 */
export async function resolvePostIdFromNoteUrl(noteUrl: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ id: posts.id })
    .from(posts)
    .where(
      and(
        eq(posts.federationUrl, noteUrl),
        eq(posts.status, 'published'),
        eq(posts.visibility, PostVisibility.PUBLIC),
      ),
    )
    .limit(1);
  return row ? row.id : null;
}

/**
 * "Every post whose AP activity id lives under this actor's URI."
 *
 * `starts_with`, NOT a `>= prefix AND < prefix || '\uffff'` range, and not a
 * `LIKE` pattern either. All three were tried and only this one is correct here:
 *
 *  - The RANGE is what Mongo's byte-ordered comparison made safe, and it does
 *    not survive the port. Under this database's `en_US.utf8` collation U+FFFF
 *    does not sort above ordinary text — measured, on the migrated schema:
 *    `'…/alice/statuses/1' >= '…/alice/'` is true but
 *    `'…/alice/statuses/1' < '…/alice/\uffff'` is FALSE. The half-open range
 *    therefore matched (almost) nothing, silently: the author backfill claimed
 *    no orphaned post and the unlinked-actor feed served an empty page, both
 *    without an error.
 *  - `LIKE` reintroduces exactly what the range existed to avoid — a pattern
 *    built from a remote-controlled URI, where an unescaped `%` or `_` widens
 *    the match.
 *
 * `starts_with` compares bytes, so a dot or a `%` in the remote username is
 * literal text, and `@bob` cannot claim `@bobsmith`'s posts because the prefix
 * is `/`-terminated by the caller.
 *
 * INDEX NOTE: this is a sequential scan on `federation_activity_id`. A btree in
 * a linguistic collation could not serve the range it replaces either (and did
 * not, since the range matched nothing), so nothing regressed — but if this ever
 * runs hot, the fix is an expression index `(federation_activity_id COLLATE "C")`
 * plus C-collated range bounds, not a return to the sentinel.
 */
export function activityIdUnderActor(actorUri: string): SQL {
  return sql`starts_with(${posts.federationActivityId}, ${`${actorUri}/`})`;
}
