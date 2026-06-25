import express, { Request, Response } from 'express';
import { IncomingMessage } from 'node:http';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { logger } from '../utils/logger';
import { RedisStore } from '../middleware/rateLimitStore';
import {
  SsrfRejection,
  UpstreamResult,
  contentTypeFamily,
  fetchUpstreamFollowingRedirects,
} from '../utils/safeUpstreamFetch';
import { extractPosterFrame } from '../utils/videoPoster';
import { lookupCacheRow, bumpAccess, recordAccessAndMaybeEnqueue } from '../services/mediaCache/cacheStore';
import { decideProxyServe } from '../services/mediaCache/policy';
import { isAllowedMediaType } from '../services/mediaCache/mediaTypes';
import { isMediaCacheEnabled, resolveOxyDownloadUrl } from '../services/mediaCache/oxyMediaStore';
import { isNegativelyCached, markNegativelyCached } from '../services/mediaCache/negativeCache';
import { classifyUpstreamStatus } from './mediaProxyStatus';

const router = express.Router();

// --- Tunables (named constants — no inline magic numbers) -------------------

/** Window for the proxy rate limiter. */
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
/** Max proxy requests per IP per window. Media-heavy feeds need a high budget. */
const RATE_LIMIT_MAX = 240;

/** Idle socket timeout while streaming the body. */
const UPSTREAM_SOCKET_TIMEOUT_MS = 30_000;
/**
 * Absolute wall-clock ceiling for a single proxied request, independent of
 * socket activity. The idle timeout above resets on every byte, so a dribbling
 * upstream could otherwise pin a connection forever; this hard deadline tears
 * the request down regardless of how slowly bytes arrive, bounding the number
 * of file descriptors a single client can hold open.
 */
const MAX_REQUEST_DURATION_MS = 60_000;

/**
 * Hard cap on a single proxied response body. Applies to the streamed bytes:
 * if an upstream sends more than this we abort the stream. Generous enough for
 * fediverse video while bounding abuse.
 */
const MAX_CONTENT_BYTES = 256 * 1024 * 1024; // 256 MiB

/** Browser/CDN cache directive for successfully proxied media. */
const MEDIA_CACHE_CONTROL = 'public, max-age=86400, immutable';

// --- Poster endpoint tunables -----------------------------------------------

/**
 * Max requests per IP per window for the poster endpoint. Lower than the proxy
 * budget because each request spawns ffmpeg (CPU) and buffers up to
 * POSTER_MAX_FETCH_BYTES — far more expensive than a passthrough stream.
 */
const POSTER_RATE_LIMIT_MAX = 60;

/**
 * Hard cap on the remote-video PREFIX we download for frame extraction. We only
 * need enough bytes for ffmpeg to find a keyframe near the start (faststart MP4,
 * WebM, etc.); we never download the whole video. Bounds memory + bandwidth per
 * poster request.
 */
const POSTER_MAX_FETCH_BYTES = 24 * 1024 * 1024; // 24 MiB

/**
 * Absolute wall-clock ceiling for a single poster request (fetch + decode). The
 * upstream-fetch deadline; ffmpeg has its own internal timeout in videoPoster.
 */
const POSTER_MAX_REQUEST_DURATION_MS = 20_000;

/** Strong cache directive for a successfully extracted poster frame. */
const POSTER_CACHE_CONTROL = 'public, max-age=604800, immutable';

/** Content type of the extracted poster frame. */
const POSTER_CONTENT_TYPE = 'image/jpeg';

/** Upstream content-type family the poster endpoint will accept (video only). */
const POSTER_REQUIRED_TYPE_PREFIX = 'video/';

/**
 * Forces the browser to render relayed media inline (never as a navigable
 * document) and discourages it from treating the bytes as an active document —
 * defense-in-depth alongside the SVG rejection and `X-Content-Type-Options`.
 */
const MEDIA_CONTENT_DISPOSITION = 'inline';

const HTTP_STATUS = {
  OK: 200,
  PARTIAL_CONTENT: 206,
  NOT_MODIFIED: 304,
  FOUND: 302,
  BAD_REQUEST: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,
  RANGE_NOT_SATISFIABLE: 416,
  BAD_GATEWAY: 502,
} as const;

// --- Rate limiter (reuses the project Redis store pattern) ------------------

const mediaProxyStore = new RedisStore({
  prefix: 'rl:media-proxy:',
  windowMs: RATE_LIMIT_WINDOW_MS,
});

const mediaProxyRateLimiter = rateLimit({
  store: mediaProxyStore,
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  // This route is unauthenticated, so key strictly by IP. ipKeyGenerator
  // normalizes IPv6 into a /64 subnet so a single client cannot evade the
  // limit by rotating addresses within its prefix (matches security.ts).
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip || req.socket.remoteAddress || 'unknown'),
  message: { error: 'Too many media proxy requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Dedicated store + limiter for the poster endpoint. A distinct Redis prefix is
// REQUIRED so the poster and proxy limiters don't increment the same key and
// halve each other's budget (rate-limit-redis double-count). Lower max because
// each poster request spawns ffmpeg.
const mediaPosterStore = new RedisStore({
  prefix: 'rl:media-poster:',
  windowMs: RATE_LIMIT_WINDOW_MS,
});

const mediaPosterRateLimiter = rateLimit({
  store: mediaPosterStore,
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: POSTER_RATE_LIMIT_MAX,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip || req.socket.remoteAddress || 'unknown'),
  message: { error: 'Too many media poster requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// --- Helpers ----------------------------------------------------------------

/** Handle for an armed request deadline (see {@link withRequestDeadline}). */
interface RequestDeadline {
  /**
   * Abort signal passed to `fetchUpstreamFollowingRedirects`. Firing the deadline
   * aborts it, tearing down the in-flight upstream request.
   */
  signal: AbortSignal;
  /**
   * Expose the live upstream response so the deadline can destroy it even while
   * streaming (the signal only aborts the request object, not the response body).
   * Called once the non-redirect response is in hand.
   */
  setActiveResponse: (response: IncomingMessage) => void;
  /** Abort the upstream request/response immediately, e.g. after client close. */
  abort: () => void;
}

/**
 * Arm an absolute wall-clock deadline for a single proxied/poster request
 * (Slowloris defense). The idle socket timeout used while streaming resets on
 * every byte, so a dribbling upstream could otherwise pin a connection forever;
 * this hard ceiling tears the request down regardless of activity.
 *
 * On expiry it aborts the in-flight upstream request (via the returned signal),
 * destroys the live upstream response if one was registered, then invokes
 * `onTimeout` with a `canRespond` flag: `true` when nothing has been sent yet
 * (the route should log AND emit its timeout status/body), `false` once a body is
 * in flight — in which case the route should only log and the helper destroys
 * `res`. The double-send guard is preserved.
 *
 * The timer is cleared on the single `res` 'close' event, which fires on every
 * terminal path. If that close is a premature client disconnect, the same event
 * also aborts the upstream work so a gone requester cannot keep sockets, buffers,
 * or poster ffmpeg jobs alive in the background.
 */
function withRequestDeadline(
  res: Response,
  maxMs: number,
  onTimeout: (canRespond: boolean) => void,
): RequestDeadline {
  const abortController = new AbortController();
  let activeResponse: IncomingMessage | null = null;

  const abortUpstream = (): void => {
    abortController.abort();
    if (activeResponse && !activeResponse.destroyed) activeResponse.destroy();
  };

  const deadlineTimer = setTimeout(() => {
    abortUpstream();
    const canRespond = !res.headersSent;
    onTimeout(canRespond);
    if (!canRespond && !res.writableEnded) {
      res.destroy();
    }
  }, maxMs);

  res.once('close', () => {
    clearTimeout(deadlineTimer);
    if (!res.writableEnded) {
      abortUpstream();
    }
  });

  return {
    signal: abortController.signal,
    setActiveResponse: (response: IncomingMessage): void => {
      activeResponse = response;
    },
    abort: abortUpstream,
  };
}

/** Relay a single upstream header to the client only when present. */
function relayHeader(res: Response, name: string, value: string | string[] | undefined): void {
  if (value === undefined) return;
  res.setHeader(name, value);
}

/**
 * Configure CORS for a PUBLIC, credential-less media response.
 *
 * The global middleware echoes a specific origin and sets
 * `Access-Control-Allow-Credentials: true`. Proxied media carries no cookies or
 * auth, so we widen access to `*` for any embedding origin — but `*` is invalid
 * alongside `Allow-Credentials: true`, so that header is removed here.
 */
function setPublicMediaCors(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.removeHeader('Access-Control-Allow-Credentials');
  // Signal to shared caches that the ACAO value depends on the request Origin,
  // preventing a credentialed per-origin response from being served from the
  // same cache entry as this wildcard one.
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  // The global middleware sets no-store Pragma/Expires for non-federation paths;
  // strip them so the cacheable Cache-Control above is honored by intermediaries.
  res.removeHeader('Pragma');
  res.removeHeader('Expires');
}

/**
 * Read at most `maxBytes` from an upstream response into a single Buffer. Once
 * the cap is hit the upstream socket is destroyed (we have enough of the prefix)
 * — this is intentional for the poster path, where a keyframe lives near the
 * start of a faststart container and the full video is never needed.
 *
 * Rejects on socket idle timeout or stream error. The returned buffer may be
 * shorter than `maxBytes` (the whole resource was smaller) — that is fine.
 */
function readBoundedPrefix(response: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (buf: Buffer): void => {
      if (settled) return;
      settled = true;
      resolve(buf);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (!response.destroyed) response.destroy();
      reject(error);
    };

    response.setTimeout(UPSTREAM_SOCKET_TIMEOUT_MS, () => {
      fail(new Error('upstream socket idle timeout'));
    });

    response.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= maxBytes) {
        // Enough of the prefix captured; stop pulling bytes.
        if (!response.destroyed) response.destroy();
        finish(Buffer.concat(chunks, Math.min(total, maxBytes)));
      }
    });
    response.on('end', () => finish(Buffer.concat(chunks, total)));
    response.on('error', (error: Error) => {
      // A destroy() triggered by hitting the cap surfaces here as an error after
      // we've already resolved; `settled` guards against rejecting in that case.
      fail(error);
    });
  });
}

/**
 * Consult the federated-media cache for a (non-range) proxy request.
 *
 * Returns `true` when the request was fully handled by redirecting to the cached
 * Oxy object (our CDN then serves the bytes). Returns `false` when the caller
 * should fall through to the existing remote-stream behaviour; in that case this
 * function has already recorded activity (bumping `lastAccessedAt` and enqueuing
 * a cache job when appropriate) WITHOUT blocking the response.
 *
 * Never throws: any cache-layer failure degrades to the remote-stream fallback,
 * preserving the proxy's current behaviour as the safety net.
 */
async function tryServeFromCache(remoteUrl: string, res: Response): Promise<boolean> {
  try {
    const decision = decideProxyServe(await lookupCacheRow(remoteUrl));

    if (decision.action === 'serve-from-oxy') {
      const oxyUrl = await resolveOxyDownloadUrl(decision.oxyFileId);
      // Bump access in the background; do not delay the redirect on the write.
      void bumpAccess(remoteUrl);
      setPublicMediaCors(res);
      res.setHeader('Cache-Control', MEDIA_CACHE_CONTROL);
      res.redirect(HTTP_STATUS.FOUND, oxyUrl);
      return true;
    }

    if (decision.action === 'stream-and-enqueue') {
      void recordAccessAndMaybeEnqueue(remoteUrl).catch((error: unknown) => {
        logger.debug('[MediaProxy] Cache enqueue failed', {
          reason: error instanceof Error ? error.message : 'unknown',
        });
      });
    } else {
      // stream-only (pending/failed): keep the entry warm, no enqueue.
      void bumpAccess(remoteUrl);
    }
    return false;
  } catch (error) {
    // Cache layer unavailable (e.g. Oxy URL resolution failed) — fall back to
    // streaming from the remote upstream, which is the existing behaviour.
    logger.debug('[MediaProxy] Cache front failed; streaming from remote', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return false;
  }
}

/**
 * Consult the federated-media cache for a poster request. Returns `true` (and
 * redirects to the cached poster in Oxy) when one exists; otherwise `false` so
 * the caller falls through to on-demand ffmpeg extraction. Never throws.
 */
async function tryServePosterFromCache(remoteUrl: string, res: Response): Promise<boolean> {
  try {
    const row = await lookupCacheRow(remoteUrl);
    if (!row?.posterFileId) return false;

    const oxyUrl = await resolveOxyDownloadUrl(row.posterFileId);
    void bumpAccess(remoteUrl);
    setPublicMediaCors(res);
    res.setHeader('Cache-Control', POSTER_CACHE_CONTROL);
    res.redirect(HTTP_STATUS.FOUND, oxyUrl);
    return true;
  } catch (error) {
    logger.debug('[MediaPoster] Cached poster lookup failed; extracting on demand', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return false;
  }
}

function shouldNegativeCacheClientError(status: number, hasRequestSpecificUpstreamHeaders: boolean): boolean {
  if (hasRequestSpecificUpstreamHeaders) return false;

  // Only memo stable "this asset is unavailable" statuses. Avoid transient or
  // request-specific 4xx such as 400 (malformed Range/conditional validators) and
  // 429 (remote rate limiting), which could otherwise poison the URL-only cache.
  return status === 401 || status === 403 || status === 404 || status === 410 || status === 451;
}

// --- Route ------------------------------------------------------------------

/**
 * GET /media/proxy?url=<url-encoded absolute http(s) media URL>
 *
 * Public, unauthenticated. Streams remote fediverse media (image/video/audio)
 * through our origin so the browser sees same-origin (CORS-safe), cacheable,
 * range-seekable bytes instead of hot-linking third-party CDNs.
 *
 * SECURITY: every upstream request — including hop 0 and each redirect hop — is
 * validated by `assertSafePublicUrl` inside `fetchUpstreamFollowingRedirects`
 * (BEFORE any socket is opened) and the TCP connection is pinned to the validated
 * IP. A blocked target surfaces as an `SsrfRejection` and maps to 403.
 */
router.get('/proxy', mediaProxyRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const rawUrl = req.query.url;
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Missing required "url" query parameter' });
    return;
  }

  // --- Activity-based cache front (only when the cache is enabled) ---
  // When the federated media cache is disabled it is COMPLETELY INERT: we touch
  // FederatedMediaCache ZERO times (no lookup, no access bump, no enqueue) and
  // fall straight through to the remote stream below — the pre-cache behaviour.
  //
  // When enabled: if this URL is already cached in Oxy, redirect so our CDN serves
  // the bytes; otherwise stream from remote (below) AND record activity to
  // (re)cache it. A range request is NOT redirected: the cached Oxy object is
  // served whole and Oxy/CDN handles range itself, but to preserve the existing
  // seek semantics we only short-circuit for full (non-range) GETs; ranged
  // requests fall through to the existing range-aware remote stream while still
  // recording access.
  const rangeHeader = req.headers.range;
  const hasRange = typeof rangeHeader === 'string' && rangeHeader.length > 0;
  const hasConditionalHeader =
    typeof req.headers['if-none-match'] === 'string' || typeof req.headers['if-modified-since'] === 'string';
  const hasRequestSpecificUpstreamHeaders = hasRange || hasConditionalHeader;

  if (isMediaCacheEnabled()) {
    if (!hasRange) {
      const cacheServed = await tryServeFromCache(rawUrl, res);
      if (cacheServed) return;
    } else {
      // Ranged request: still record activity so the entry stays warm / gets cached.
      void recordAccessAndMaybeEnqueue(rawUrl).catch((error: unknown) => {
        logger.debug('[MediaProxy] Cache record (ranged) failed', {
          reason: error instanceof Error ? error.message : 'unknown',
        });
      });
    }
  }

  // --- Negative cache short-circuit ---
  // Check this only after the normal cache front has had a chance to serve full
  // requests, so a stale negative marker can never suppress already cached media.
  // URL-only negative entries are also skipped for ranged/conditional requests:
  // those forwarded headers can make an otherwise valid upstream reply with a
  // request-specific 4xx/304/416 and must not poison or consume the URL cache.
  if (!hasRequestSpecificUpstreamHeaders && (await isNegativelyCached(rawUrl))) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Upstream media unavailable' });
    return;
  }

  const extras = {
    range: hasRange && typeof rangeHeader === 'string' ? rangeHeader : undefined,
    ifNoneMatch: typeof req.headers['if-none-match'] === 'string' ? req.headers['if-none-match'] : undefined,
    ifModifiedSince:
      typeof req.headers['if-modified-since'] === 'string' ? req.headers['if-modified-since'] : undefined,
  };

  // Absolute request deadline (Slowloris defense): hard wall-clock ceiling that
  // tears the request down regardless of socket activity.
  const deadline = withRequestDeadline(res, MAX_REQUEST_DURATION_MS, (canRespond) => {
    logger.warn('[MediaProxy] Aborting request past absolute deadline', {
      maxMs: MAX_REQUEST_DURATION_MS,
    });
    if (canRespond) {
      res.status(HTTP_STATUS.BAD_GATEWAY).json({ error: 'Upstream media timed out' });
    }
  });

  let upstream: UpstreamResult;
  try {
    upstream = await fetchUpstreamFollowingRedirects(rawUrl, extras, deadline.signal);
  } catch (error) {
    // The deadline timer may already have responded (it aborts the in-flight
    // request, which surfaces here as an AbortError); don't double-send.
    if (res.headersSent || res.writableEnded) {
      return;
    }
    if (error instanceof SsrfRejection) {
      logger.warn('[MediaProxy] Rejected redirect target', { reason: error.message });
      res.status(HTTP_STATUS.FORBIDDEN).json({ error: 'URL not permitted' });
      return;
    }
    // A connection/network failure (DNS, refused, reset, headers timeout). This
    // is a genuine gateway problem → 502. Memo it under a SHORT TTL so a remote
    // that is briefly unreachable isn't re-dialed on every feed render, while
    // still recovering quickly if the blip was transient.
    logger.warn('[MediaProxy] Upstream fetch failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    void markNegativelyCached(rawUrl, 'connection-error');
    res.status(HTTP_STATUS.BAD_GATEWAY).json({ error: 'Upstream media unavailable' });
    return;
  }

  const { response } = upstream;
  // Expose the live response to the deadline timer so it can be torn down even
  // while streaming (the signal only aborts the request object, not the body).
  deadline.setActiveResponse(response);
  const upstreamStatus = response.statusCode ?? HTTP_STATUS.BAD_GATEWAY;
  const statusClass = classifyUpstreamStatus(upstreamStatus);

  // 304 from a conditional request: relay validators, no body.
  if (statusClass === 'not-modified') {
    response.resume();
    relayHeader(res, 'ETag', response.headers.etag);
    relayHeader(res, 'Last-Modified', response.headers['last-modified']);
    res.setHeader('Cache-Control', MEDIA_CACHE_CONTROL);
    setPublicMediaCors(res);
    res.status(HTTP_STATUS.NOT_MODIFIED).end();
    return;
  }

  // 416 Range Not Satisfiable: relay the Content-Range so the client can adjust.
  if (statusClass === 'range-not-satisfiable') {
    response.resume();
    relayHeader(res, 'Content-Range', response.headers['content-range']);
    res.status(HTTP_STATUS.RANGE_NOT_SATISFIABLE).end();
    return;
  }

  // Client-class (4xx) upstream: the remote asset was deleted, made private, or
  // is hotlink-protected. That is NOT a gateway fault — answer 404, log at debug
  // (expected, high-volume), and negative-cache the URL so we stop re-fetching a
  // known-dead asset on every feed render.
  if (statusClass === 'client-error') {
    response.resume();
    logger.debug('[MediaProxy] Upstream returned client-error status', { status: upstreamStatus });
    if (shouldNegativeCacheClientError(upstreamStatus, hasRequestSpecificUpstreamHeaders)) {
      void markNegativelyCached(rawUrl, 'client-error');
    }
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Upstream media unavailable' });
    return;
  }

  // Genuine upstream 5xx / unrelayable status: a real gateway problem → 502. NOT
  // negative-cached because it may be transient.
  if (statusClass !== 'media') {
    response.resume();
    logger.warn('[MediaProxy] Upstream returned server-error status', { status: upstreamStatus });
    res.status(HTTP_STATUS.BAD_GATEWAY).json({ error: 'Upstream media unavailable' });
    return;
  }

  // Content-type gate: only relay image/video/audio.
  const family = contentTypeFamily(response.headers);
  if (!isAllowedMediaType(family)) {
    response.destroy();
    logger.warn('[MediaProxy] Rejected non-media content type', { contentType: family || 'unknown' });
    res.status(HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE).json({ error: 'Upstream is not a supported media type' });
    return;
  }

  // Reject over-large declared bodies up front (streamed bytes are also capped).
  // The upstream answered fine (200/206) — this is OUR policy rejecting an
  // oversized body, so it is 413 Payload Too Large, not a 502 gateway error.
  const declaredLength = Number(response.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CONTENT_BYTES) {
    response.destroy();
    logger.warn('[MediaProxy] Upstream body exceeds cap', { declaredLength });
    res.status(HTTP_STATUS.PAYLOAD_TOO_LARGE).json({ error: 'Upstream media too large' });
    return;
  }

  // --- Relay response headers (public, cacheable, range-aware) ---
  res.setHeader('Content-Type', response.headers['content-type'] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', MEDIA_CACHE_CONTROL);
  setPublicMediaCors(res);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', MEDIA_CONTENT_DISPOSITION);
  res.setHeader('Accept-Ranges', response.headers['accept-ranges'] ?? 'bytes');
  relayHeader(res, 'Content-Length', response.headers['content-length']);
  relayHeader(res, 'Content-Range', response.headers['content-range']);
  relayHeader(res, 'ETag', response.headers.etag);
  relayHeader(res, 'Last-Modified', response.headers['last-modified']);

  res.status(upstreamStatus === HTTP_STATUS.PARTIAL_CONTENT ? HTTP_STATUS.PARTIAL_CONTENT : HTTP_STATUS.OK);

  // --- Stream the body (never buffer whole videos) ---
  response.setTimeout(UPSTREAM_SOCKET_TIMEOUT_MS, () => {
    response.destroy(new Error('upstream socket idle timeout'));
  });

  let streamedBytes = 0;
  let aborted = false;

  response.on('data', (chunk: Buffer) => {
    streamedBytes += chunk.length;
    if (streamedBytes > MAX_CONTENT_BYTES && !aborted) {
      aborted = true;
      logger.warn('[MediaProxy] Aborting stream past size cap', { streamedBytes });
      response.destroy();
      res.destroy();
    }
  });

  response.on('error', (error: Error) => {
    logger.warn('[MediaProxy] Upstream stream error', { reason: error.message });
    if (!res.headersSent) {
      res.status(HTTP_STATUS.BAD_GATEWAY).json({ error: 'Upstream media unavailable' });
    } else {
      res.destroy();
    }
  });

  // If the client disconnects, tear down the upstream socket to free resources.
  res.on('close', () => {
    if (!response.destroyed) response.destroy();
  });

  response.pipe(res);
});

/**
 * GET /media/poster?url=<url-encoded absolute http(s) video URL>
 *
 * Public, unauthenticated. Returns a single `image/jpeg` frame extracted near
 * the start of a remote (federated) video so the frontend can show a thumbnail
 * instead of a black box until the first frame decodes.
 *
 * SECURITY: ffmpeg NEVER touches the network. We (1) SSRF-validate the URL and
 * every redirect hop via `assertSafePublicUrl` inside
 * `fetchUpstreamFollowingRedirects` (BEFORE any socket is opened) with the
 * connection pinned to the validated IP — a blocked target surfaces as an
 * `SsrfRejection` and maps to 403, (2) download a bounded prefix
 * (POSTER_MAX_FETCH_BYTES) to a temp file, then (3) run ffmpeg ONLY on that local
 * file with `-protocol_whitelist file` — so even a crafted container cannot make
 * ffmpeg fetch a URL or read an arbitrary local path. On any failure (non-video,
 * no decodable frame in the prefix, ffmpeg error/timeout) we respond 404 so the
 * frontend falls back to a placeholder.
 */
router.get('/poster', mediaPosterRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const rawUrl = req.query.url;
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Missing required "url" query parameter' });
    return;
  }

  // --- Cached poster front (only when the cache is enabled) ---
  // When the cache is disabled this is COMPLETELY INERT — no FederatedMediaCache
  // lookup, no access bump — and we fall straight through to on-demand ffmpeg
  // extraction, the pre-cache behaviour. When enabled: if a cached entry for this
  // video already has a poster frame in Oxy, redirect to it instead of re-running
  // ffmpeg. Never throws — falls through to on-demand extraction on any failure.
  if (isMediaCacheEnabled() && (await tryServePosterFromCache(rawUrl, res))) {
    return;
  }

  // Absolute request deadline (fetch + decode): hard wall-clock ceiling that
  // tears the request down regardless of socket activity.
  const deadline = withRequestDeadline(res, POSTER_MAX_REQUEST_DURATION_MS, (canRespond) => {
    logger.warn('[MediaPoster] Aborting request past absolute deadline', {
      maxMs: POSTER_MAX_REQUEST_DURATION_MS,
    });
    if (canRespond) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Poster unavailable' });
    }
  });

  // --- Fetch the SSRF-validated upstream (redirects re-validated per hop) ---
  let upstream: UpstreamResult;
  try {
    upstream = await fetchUpstreamFollowingRedirects(rawUrl, {}, deadline.signal);
  } catch (error) {
    if (res.headersSent || res.writableEnded) {
      return;
    }
    if (error instanceof SsrfRejection) {
      logger.warn('[MediaPoster] Rejected redirect target', { reason: error.message });
      res.status(HTTP_STATUS.FORBIDDEN).json({ error: 'URL not permitted' });
      return;
    }
    logger.warn('[MediaPoster] Upstream fetch failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Poster unavailable' });
    return;
  }

  const { response } = upstream;
  deadline.setActiveResponse(response);
  const upstreamStatus = response.statusCode ?? HTTP_STATUS.BAD_GATEWAY;

  // Only a 200 with a full body lets us extract a leading frame.
  if (upstreamStatus !== HTTP_STATUS.OK) {
    response.resume();
    logger.warn('[MediaPoster] Upstream returned non-OK status', { status: upstreamStatus });
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Poster unavailable' });
    return;
  }

  // Require an actual video content type. ffmpeg never sees this URL, but
  // rejecting non-video up front avoids buffering/decoding unrelated bytes.
  const family = contentTypeFamily(response.headers);
  if (!family.startsWith(POSTER_REQUIRED_TYPE_PREFIX)) {
    response.destroy();
    logger.warn('[MediaPoster] Upstream is not a video', { contentType: family || 'unknown' });
    res.status(HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE).json({ error: 'Upstream is not a video' });
    return;
  }

  // --- Buffer a bounded prefix of the video ---
  let prefix: Buffer;
  try {
    prefix = await readBoundedPrefix(response, POSTER_MAX_FETCH_BYTES);
  } catch (error) {
    if (res.headersSent || res.writableEnded) {
      return;
    }
    logger.warn('[MediaPoster] Failed to read upstream prefix', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Poster unavailable' });
    return;
  }

  if (prefix.length === 0) {
    if (!res.headersSent) res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Poster unavailable' });
    return;
  }

  if (deadline.signal.aborted || res.destroyed || res.writableEnded) {
    deadline.abort();
    return;
  }

  // --- Extract one frame with network-sandboxed ffmpeg (local temp file) ---
  const poster = await extractPosterFrame(prefix);

  if (res.headersSent || res.writableEnded) {
    // The deadline timer already responded (or the client disconnected).
    return;
  }

  if (!poster.ok) {
    // No decodable frame in the prefix (e.g. non-faststart MP4 with moov at the
    // end), or ffmpeg failed/timed out — the frontend falls back to a placeholder.
    logger.warn('[MediaPoster] Frame extraction failed', { reason: poster.reason });
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Poster unavailable' });
    return;
  }

  res.setHeader('Content-Type', POSTER_CONTENT_TYPE);
  res.setHeader('Cache-Control', POSTER_CACHE_CONTROL);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', MEDIA_CONTENT_DISPOSITION);
  res.setHeader('Content-Length', poster.jpeg.length);
  setPublicMediaCors(res);
  res.status(HTTP_STATUS.OK).end(poster.jpeg);
});

export default router;
