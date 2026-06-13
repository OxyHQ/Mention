import express, { Request, Response } from 'express';
import http, { IncomingMessage, IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { logger } from '../utils/logger';
import { RedisStore } from '../middleware/rateLimitStore';
import { assertSafePublicUrl } from '../utils/ssrfGuard';

const router = express.Router();

// --- Tunables (named constants — no inline magic numbers) -------------------

/** Window for the proxy rate limiter. */
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
/** Max proxy requests per IP per window. Media-heavy feeds need a high budget. */
const RATE_LIMIT_MAX = 240;

/** Time to wait for the upstream to send response headers before aborting. */
const UPSTREAM_HEADERS_TIMEOUT_MS = 10_000;
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

/** Maximum number of HTTP redirects to follow; each hop is re-validated. */
const MAX_REDIRECTS = 3;

/**
 * Hard cap on a single proxied response body. Applies to the streamed bytes:
 * if an upstream sends more than this we abort the stream. Generous enough for
 * fediverse video while bounding abuse.
 */
const MAX_CONTENT_BYTES = 256 * 1024 * 1024; // 256 MiB

/** Browser/CDN cache directive for successfully proxied media. */
const MEDIA_CACHE_CONTROL = 'public, max-age=86400, immutable';

/** User-Agent presented to upstream fediverse CDNs. */
const PROXY_USER_AGENT = 'MentionMediaProxy/1.0 (+https://mention.earth)';

/** Media content-type families this proxy is willing to relay. */
const ALLOWED_CONTENT_TYPE_PREFIXES = ['image/', 'video/', 'audio/'] as const;

/**
 * Content types that are explicitly rejected even though they match an allowed
 * prefix. SVG matches `image/` but is an XML document that can embed
 * `<script>`/event handlers; relaying it same-origin would enable stored XSS.
 */
const REJECTED_CONTENT_TYPES: ReadonlySet<string> = new Set(['image/svg+xml']);

/**
 * Forces the browser to render relayed media inline (never as a navigable
 * document) and discourages it from treating the bytes as an active document —
 * defense-in-depth alongside the SVG rejection and `X-Content-Type-Options`.
 */
const MEDIA_CONTENT_DISPOSITION = 'inline';

/** HTTP status codes that indicate a redirect we should follow. */
const REDIRECT_STATUS_CODES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

const HTTP_STATUS = {
  OK: 200,
  PARTIAL_CONTENT: 206,
  NOT_MODIFIED: 304,
  BAD_REQUEST: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RANGE_NOT_SATISFIABLE: 416,
  UNSUPPORTED_MEDIA_TYPE: 415,
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

// --- Helpers ----------------------------------------------------------------

interface UpstreamResult {
  response: IncomingMessage;
  finalUrl: string;
}

/**
 * Build the request options for a single hop, pinning the TCP connection to the
 * already-validated IP via a custom `lookup`. This closes the DNS-rebind TOCTOU
 * window: the address we validated is exactly the address Node connects to.
 */
function buildRequestOptions(
  target: URL,
  pinnedIp: string,
  pinnedFamily: 4 | 6,
  clientRange: string | undefined,
  conditional: { ifNoneMatch?: string; ifModifiedSince?: string },
  signal: AbortSignal,
): https.RequestOptions {
  const headers: Record<string, string> = {
    'User-Agent': PROXY_USER_AGENT,
    Accept: 'image/*,video/*,audio/*,*/*;q=0.8',
    'Accept-Encoding': 'identity',
  };
  if (clientRange) headers.Range = clientRange;
  if (conditional.ifNoneMatch) headers['If-None-Match'] = conditional.ifNoneMatch;
  if (conditional.ifModifiedSince) headers['If-Modified-Since'] = conditional.ifModifiedSince;

  return {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    method: 'GET',
    headers,
    // Aborts the in-flight request when the absolute request deadline fires.
    signal,
    // Pin the connection to the validated IP — DNS is NOT re-resolved here.
    lookup: (
      _hostname: string,
      _options: unknown,
      callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
    ): void => {
      callback(null, pinnedIp, pinnedFamily);
    },
  };
}

/** Perform a single upstream GET (no auto-redirect). */
function fetchOnce(options: https.RequestOptions, isHttps: boolean): Promise<IncomingMessage> {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const transport = isHttps ? https : http;
    const req = transport.request(options, (res) => resolve(res));

    req.setTimeout(UPSTREAM_HEADERS_TIMEOUT_MS, () => {
      req.destroy(new Error('upstream headers timeout'));
    });
    req.on('error', (err) => reject(err));
    req.end();
  });
}

/**
 * Fetch the upstream media, following up to MAX_REDIRECTS redirects and
 * re-running the SSRF check (DNS + IP-range validation) on every hop. Returns
 * the first non-redirect response. Drains and discards redirect-response bodies.
 */
async function fetchUpstreamFollowingRedirects(
  initialUrl: string,
  clientRange: string | undefined,
  conditional: { ifNoneMatch?: string; ifModifiedSince?: string },
  signal: AbortSignal,
): Promise<UpstreamResult> {
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const guard = await assertSafePublicUrl(currentUrl);
    if (!guard.ok) {
      throw new SsrfRejection(guard.reason);
    }

    const target = new URL(currentUrl);
    const options = buildRequestOptions(target, guard.ip, guard.family, clientRange, conditional, signal);
    const response = await fetchOnce(options, target.protocol === 'https:');

    const status = response.statusCode ?? 0;
    if (REDIRECT_STATUS_CODES.has(status)) {
      const location = response.headers.location;
      // We only need the Location header. Destroy immediately rather than
      // draining (resume()) the redirect body, which could be unbounded.
      response.destroy();

      if (hop === MAX_REDIRECTS) {
        throw new UpstreamError('too many redirects');
      }
      if (!location || typeof location !== 'string') {
        throw new UpstreamError('redirect without location');
      }
      // Resolve relative redirects against the current URL.
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return { response, finalUrl: currentUrl };
  }

  // Unreachable: the loop either returns a response or throws.
  throw new UpstreamError('redirect loop exhausted');
}

/** Marker error for a blocked SSRF target (maps to 403). */
class SsrfRejection extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SsrfRejection';
  }
}

/** Marker error for a generic upstream failure (maps to 502). */
class UpstreamError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UpstreamError';
  }
}

/** Extract the bare media type family (strips parameters and casing). */
function contentTypeFamily(headers: IncomingHttpHeaders): string {
  const raw = headers['content-type'];
  if (typeof raw !== 'string') return '';
  return raw.split(';')[0]?.trim().toLowerCase() ?? '';
}

function isAllowedMediaType(contentType: string): boolean {
  if (REJECTED_CONTENT_TYPES.has(contentType)) return false;
  return ALLOWED_CONTENT_TYPE_PREFIXES.some((prefix) => contentType.startsWith(prefix));
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

// --- Route ------------------------------------------------------------------

/**
 * GET /media/proxy?url=<url-encoded absolute http(s) media URL>
 *
 * Public, unauthenticated. Streams remote fediverse media (image/video/audio)
 * through our origin so the browser sees same-origin (CORS-safe), cacheable,
 * range-seekable bytes instead of hot-linking third-party CDNs.
 *
 * SECURITY: every upstream request — including each redirect hop — is validated
 * by `assertSafePublicUrl` and the TCP connection is pinned to the validated IP.
 */
router.get('/proxy', mediaProxyRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const rawUrl = req.query.url;
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Missing required "url" query parameter' });
    return;
  }

  // Pre-validate before opening any socket so obviously bad input fails fast.
  const preCheck = await assertSafePublicUrl(rawUrl);
  if (!preCheck.ok) {
    logger.warn('[MediaProxy] Rejected target', { reason: preCheck.reason });
    res.status(HTTP_STATUS.FORBIDDEN).json({ error: 'URL not permitted' });
    return;
  }

  const clientRange = typeof req.headers.range === 'string' ? req.headers.range : undefined;
  const conditional = {
    ifNoneMatch: typeof req.headers['if-none-match'] === 'string' ? req.headers['if-none-match'] : undefined,
    ifModifiedSince:
      typeof req.headers['if-modified-since'] === 'string' ? req.headers['if-modified-since'] : undefined,
  };

  // Absolute request deadline (Slowloris defense). The idle socket timeout below
  // resets on every byte, so a dribbling upstream could pin a connection forever.
  // This hard ceiling aborts the in-flight upstream request (via the signal),
  // destroys the streamed response and ends the client response regardless of
  // activity. It is cleared on the single `res` 'close' event, which fires on
  // every terminal path: success, error, or client disconnect.
  const abortController = new AbortController();
  let activeResponse: IncomingMessage | null = null;
  const deadlineTimer = setTimeout(() => {
    logger.warn('[MediaProxy] Aborting request past absolute deadline', {
      maxMs: MAX_REQUEST_DURATION_MS,
    });
    abortController.abort();
    if (activeResponse && !activeResponse.destroyed) activeResponse.destroy();
    if (!res.headersSent) {
      res.status(HTTP_STATUS.BAD_GATEWAY).json({ error: 'Upstream media timed out' });
    } else if (!res.writableEnded) {
      res.destroy();
    }
  }, MAX_REQUEST_DURATION_MS);
  res.once('close', () => {
    clearTimeout(deadlineTimer);
  });

  let upstream: UpstreamResult;
  try {
    upstream = await fetchUpstreamFollowingRedirects(rawUrl, clientRange, conditional, abortController.signal);
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
    logger.warn('[MediaProxy] Upstream fetch failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    res.status(HTTP_STATUS.BAD_GATEWAY).json({ error: 'Upstream media unavailable' });
    return;
  }

  const { response } = upstream;
  // Expose the live response to the deadline timer so it can be torn down even
  // while streaming (the signal only aborts the request object, not the body).
  activeResponse = response;
  const upstreamStatus = response.statusCode ?? HTTP_STATUS.BAD_GATEWAY;

  // 304 from a conditional request: relay validators, no body.
  if (upstreamStatus === HTTP_STATUS.NOT_MODIFIED) {
    response.resume();
    relayHeader(res, 'ETag', response.headers.etag);
    relayHeader(res, 'Last-Modified', response.headers['last-modified']);
    res.setHeader('Cache-Control', MEDIA_CACHE_CONTROL);
    setPublicMediaCors(res);
    res.status(HTTP_STATUS.NOT_MODIFIED).end();
    return;
  }

  // Only 200/206 carry a media body we relay; anything else is an upstream error.
  if (upstreamStatus !== HTTP_STATUS.OK && upstreamStatus !== HTTP_STATUS.PARTIAL_CONTENT) {
    response.resume();
    if (upstreamStatus === HTTP_STATUS.RANGE_NOT_SATISFIABLE) {
      relayHeader(res, 'Content-Range', response.headers['content-range']);
      res.status(HTTP_STATUS.RANGE_NOT_SATISFIABLE).end();
      return;
    }
    logger.warn('[MediaProxy] Upstream returned non-media status', { status: upstreamStatus });
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
  const declaredLength = Number(response.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CONTENT_BYTES) {
    response.destroy();
    logger.warn('[MediaProxy] Upstream body exceeds cap', { declaredLength });
    res.status(HTTP_STATUS.BAD_GATEWAY).json({ error: 'Upstream media too large' });
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

export default router;
