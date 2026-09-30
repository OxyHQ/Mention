/**
 * Host-aware apex frontend reverse-proxy — the "bskyweb-full" model.
 *
 * When the frontend apex host (`mention.earth`) resolves to THIS backend (via the
 * ALB), every request that isn't a federation endpoint or an OG web-shell page
 * must be served the static Expo frontend. This middleware reverse-proxies those
 * apex requests to the frontend's static CDN — a Cloudflare Worker on
 * `shell.mention.earth` — which is how `mention.earth` DNS can point at the ALB.
 * That origin serves nothing without {@link SHELL_ACCESS_HEADER}, so this
 * middleware is one of only two callers that can reach the app's own bytes.
 *
 * It is a STRICT no-op for the API host (`api.mention.earth`): a non-apex request
 * calls `next()` untouched, so every existing API route behaves exactly as before.
 *
 * Mount order (see app.ts): it runs AFTER the federation routers (`/ap`,
 * `/.well-known`, `/xrpc`, `/nodeinfo`, `/media`) and the OG web-shell (`/@…`,
 * `/p/…`) — those must keep serving their own content on the apex host too — but
 * BEFORE the API routers, so apex SPA routes whose prefixes collide with API
 * mounts (`/feed`, `/notifications`, `/lists`, `/starter-packs`, `/topics`,
 * `/trending`, `/articles`, `/recommendations`, `/hashtags`, `/feeds`, …) are
 * proxied to the SPA instead of hitting the API. The SPA fetches the API from
 * `api.mention.earth`, so those apex paths are always frontend routes.
 *
 * Fail-soft: a slow/broken CDN yields a 502 with a minimal bootable shell rather
 * than a crash or a hung apex.
 */
import http, { type IncomingMessage } from 'http';
import https from 'https';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { logger } from '../utils/logger';
import { SHELL_ACCESS_HEADER, invalidateShellDocument } from '../services/webShellDocument';

/**
 * The frontend apex host (`mention.earth`). Derived from the SAME `MENTION_WEB_ORIGIN`
 * config the OG web-shell renderer uses, so the public web origin is defined in one
 * place. Only the bare hostname (no scheme / port) is compared.
 */
const APEX_HOST = extractHost(config.web.origin);

/**
 * Static frontend CDN the SPA + its assets are proxied from (a Cloudflare Worker).
 * Reuses `WEB_SHELL_ORIGIN` — the same origin the OG web-shell fetches its shell
 * from — so the CDN origin is configured in exactly one place. Trailing slash is
 * stripped so it concatenates cleanly with `req.originalUrl` (which starts `/`).
 */
const FRONTEND_CDN_ORIGIN = config.web.shellOrigin;

/**
 * Header the shell Worker requires before it serves a byte
 * (`packages/frontend/worker/index.js`). Defined beside the shell document cache
 * that also presents it, and re-exported here, where callers import it from.
 */
export { SHELL_ACCESS_HEADER };

/** Hard timeout for a single upstream proxy fetch. The apex must never hang on a slow CDN. */
const PROXY_FETCH_TIMEOUT_MS = 8000;

/** Max upstream redirects to follow before giving up (a static CDN needs very few). */
const MAX_PROXY_REDIRECTS = 3;

const CONTENT_HASHED_ASSET =
  /\/[^/?]+-[a-f0-9]{8,}\.(?:js|css|map|json|png|jpe?g|webp|avif|svg|woff2?|ttf|otf)$/i;

function isHtmlContentType(contentType: string | string[] | undefined): boolean {
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  return typeof value === 'string' && value.toLowerCase().includes('text/html');
}

function isContentHashedAsset(path: string): boolean {
  return CONTENT_HASHED_ASSET.test(path);
}

/**
 * Minimal, valid HTML returned only when the CDN is unreachable — never a crash,
 * never a blank 500. Browsers hitting this rare state reboot the SPA once the CDN
 * recovers.
 */
const PROXY_FALLBACK_HTML =
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Mention</title>' +
  '</head><body><div id="root"></div></body></html>';

/** Extract a bare lowercase hostname (no scheme, no port) from an origin URL or host string. */
function extractHost(origin: string): string {
  const withScheme = /^https?:\/\//i.test(origin) ? origin : `https://${origin}`;
  try {
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return origin.replace(/^https?:\/\//i, '').replace(/[:/].*$/, '').toLowerCase();
  }
}

/** Normalize a `Host` / `X-Forwarded-Host` token to a bare lowercase hostname (drops any `:port`). */
function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/:\d+$/, '');
}

/**
 * True when the request targets the frontend apex (`mention.earth`) rather than the
 * API host (`api.mention.earth`). Checks the ALB-forwarded `X-Forwarded-Host`
 * (first token — the original client host) AND Express's resolved `req.hostname`
 * (which also honors `X-Forwarded-Host` under `trust proxy`). Non-apex hosts are API.
 */
export function isApexHost(req: Request): boolean {
  const forwarded = req.headers['x-forwarded-host'];
  const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (forwardedValue) {
    const first = forwardedValue.split(',')[0];
    if (first && normalizeHost(first) === APEX_HOST) return true;
  }
  if (req.hostname && normalizeHost(req.hostname) === APEX_HOST) return true;
  return false;
}

/**
 * Only browser HTML/static requests bypass the API limiter. ActivityPub,
 * WebFinger, XRPC and media routes on the same apex remain protected.
 */
export function isApexWebPlaneRequest(req: Request): boolean {
  if (!isApexHost(req) || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
  if (
    req.path.startsWith('/ap/') ||
    req.path.startsWith('/.well-known/') ||
    req.path.startsWith('/xrpc/') ||
    req.path.startsWith('/media/')
  ) {
    return false;
  }
  const accept = req.header('accept')?.toLowerCase() ?? '';
  return !accept.includes('application/activity+json') &&
    !accept.includes('application/ld+json');
}

/**
 * Issue ONE upstream request to the frontend CDN with Node's raw http/https
 * client and resolve with the FINAL {@link IncomingMessage} (redirects already
 * followed). Unlike the global `fetch` (undici), the raw client does NOT
 * transparently decompress the body, so the CDN's already-compressed bytes
 * (Brotli/gzip) and their `Content-Encoding` header stay consistent and can be
 * relayed to the browser verbatim — no decode-then-re-encode round trip. Rejects
 * on connection/timeout errors; never resolves with a redirect (a `304 Not
 * Modified`, which carries no Location, is an answer and is resolved).
 *
 * `deadline` bounds the time to the FINAL response's headers across every
 * redirect hop. The socket timeout alone is an inactivity limit that each hop
 * restarts, so an upstream that trickles bytes or redirects three times could
 * otherwise hold the request well past it. The body is not under the deadline:
 * it streams at the client's pace, still covered by the inactivity limit.
 */
function requestUpstream(
  targetUrl: string,
  options: { method: string; headers: Record<string, string> },
  redirectsLeft: number,
  deadline: number = Date.now() + PROXY_FETCH_TIMEOUT_MS,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      reject(new Error(`Upstream did not answer within ${PROXY_FETCH_TIMEOUT_MS}ms`));
      return;
    }
    let url: URL;
    try {
      url = new URL(targetUrl);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const client = url.protocol === 'http:' ? http : https;
    const upstreamRequest = client.request(
      url,
      { method: options.method, headers: options.headers },
      (upstream) => {
        clearTimeout(headersTimer);
        const status = upstream.statusCode ?? 502;
        const location = upstream.headers.location;
        if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
          // Drain the redirect body and follow the hop; a relative Location
          // resolves against the current URL.
          upstream.resume();
          const nextUrl = new URL(location, url).toString();
          requestUpstream(nextUrl, options, redirectsLeft - 1, deadline).then(resolve, reject);
          return;
        }
        resolve(upstream);
      },
    );

    const headersTimer = setTimeout(() => {
      upstreamRequest.destroy(new Error(`Upstream did not answer within ${PROXY_FETCH_TIMEOUT_MS}ms`));
    }, remaining);
    upstreamRequest.on('error', (error) => {
      clearTimeout(headersTimer);
      reject(error);
    });
    upstreamRequest.setTimeout(PROXY_FETCH_TIMEOUT_MS, () => {
      upstreamRequest.destroy(new Error(`Upstream request exceeded ${PROXY_FETCH_TIMEOUT_MS}ms`));
    });
    upstreamRequest.end();
  });
}

/** The client's cache validators, forwarded so the CDN can answer `304`. */
function conditionalHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  const ifNoneMatch = req.headers['if-none-match'];
  if (typeof ifNoneMatch === 'string' && ifNoneMatch.length > 0) headers['If-None-Match'] = ifNoneMatch;
  const ifModifiedSince = req.headers['if-modified-since'];
  if (typeof ifModifiedSince === 'string' && ifModifiedSince.length > 0) {
    headers['If-Modified-Since'] = ifModifiedSince;
  }
  return headers;
}

/**
 * Reverse-proxy one apex request to the static frontend CDN, STREAMING the
 * upstream body straight through (never buffering the ~11 MB bundle in memory)
 * and PRESERVING the CDN's compression end-to-end. Fail-soft: never throws,
 * never hangs.
 */
async function proxyToFrontend(req: Request, res: Response): Promise<void> {
  const target = `${FRONTEND_CDN_ORIGIN}${req.originalUrl}`;

  // Forward the client's REAL Accept-Encoding so the CDN can answer with Brotli/
  // gzip; that compressed body is relayed verbatim below. A client that advertised
  // no encoding gets `identity` — never a compressed body it cannot decode.
  const clientAcceptEncoding = req.headers['accept-encoding'];
  const acceptEncoding =
    typeof clientAcceptEncoding === 'string' && clientAcceptEncoding.length > 0
      ? clientAcceptEncoding
      : 'identity';

  let upstream: IncomingMessage;
  try {
    upstream = await requestUpstream(
      target,
      {
        method: req.method,
        headers: {
          Accept: typeof req.headers.accept === 'string' ? req.headers.accept : '*/*',
          'Accept-Encoding': acceptEncoding,
          'User-Agent':
            typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : 'Mention-apex-proxy',
          // Never taken from the client: this is OUR credential for the shell
          // origin, not something a caller may influence.
          [SHELL_ACCESS_HEADER]: config.web.shellAccessKey ?? '',
          // The browser's validators, so a copy it already holds is revalidated
          // with a bodiless 304 instead of downloaded again.
          ...conditionalHeaders(req),
        },
      },
      MAX_PROXY_REDIRECTS,
    );
  } catch (error) {
    logger.warn('[apexProxy] upstream fetch failed', error);
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(502);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(PROXY_FALLBACK_HTML);
    return;
  }

  const contentType = upstream.headers['content-type'];
  if (isContentHashedAsset(req.path) && isHtmlContentType(contentType)) {
    // The SPA fallback must never be cached at a hashed static-asset URL.
    upstream.resume();
    // A document that names a chunk the Worker no longer has is from a previous
    // release. Stop building pages from the copy this task holds.
    invalidateShellDocument();
    res.status(404);
    res.setHeader('Cache-Control', 'no-store');
    res.removeHeader('Pragma');
    res.removeHeader('Expires');
    res.end();
    return;
  }

  const status = upstream.statusCode ?? 502;
  res.status(status);
  if (contentType) res.setHeader('Content-Type', contentType);

  // Relay the CDN's Content-Encoding + its matching Content-Length UNCHANGED: the
  // raw (still-compressed) bytes are streamed through as-is, so the browser
  // decodes them directly. Because Content-Encoding is set, the outer
  // `compression` middleware treats the response as already-encoded and does NOT
  // re-compress it (which would waste CPU and, worse, double-encode the body).
  const contentEncoding = upstream.headers['content-encoding'];
  if (contentEncoding) res.setHeader('Content-Encoding', contentEncoding);
  const contentLength = upstream.headers['content-length'];
  if (contentLength) res.setHeader('Content-Length', contentLength);

  // Pass the CDN's caching directives through, overriding the API `no-store`
  // default the CORS middleware set — this is what lets the browser/edge cache the
  // static assets (`/_expo/static/*`, `/icons/*`, `/manifest.json`, `/favicon.ico`, …).
  const cacheControl = upstream.headers['cache-control'];
  if (status >= 400) {
    // An error is never an asset: cached at a hashed URL it would be served in
    // place of the real file for a year, by the browser and every shared cache.
    res.setHeader('Cache-Control', 'no-store');
  } else if (isContentHashedAsset(req.path)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (isHtmlContentType(contentType)) {
    res.setHeader('Cache-Control', 'no-cache');
  } else {
    res.setHeader('Cache-Control', cacheControl ?? 'public, max-age=60');
  }
  res.removeHeader('Pragma');
  res.removeHeader('Expires');
  const etag = upstream.headers['etag'];
  if (etag) res.setHeader('ETag', etag);
  const lastModified = upstream.headers['last-modified'];
  if (lastModified) res.setHeader('Last-Modified', lastModified);
  // The body varies by encoding — keep the CDN's Vary (or set the minimum) so a
  // shared cache never hands a Brotli body to a client that only accepts gzip.
  const vary = upstream.headers['vary'];
  res.setHeader('Vary', vary ?? 'Accept-Encoding');

  if (req.method === 'HEAD') {
    upstream.resume(); // discard any body bytes
    res.end();
    return;
  }

  // If the client aborts, stop pulling from the CDN so the upstream socket is
  // released rather than left draining a large asset into a dead response.
  res.on('close', () => {
    if (!upstream.destroyed) upstream.destroy();
  });

  // On an upstream stream error mid-flight the partially-sent response cannot be
  // recovered — tear it down rather than hang.
  upstream.on('error', (error) => {
    logger.warn('[apexProxy] upstream stream error', error);
    res.destroy();
  });

  // Stream the body straight to the client (no full-bundle buffer in memory).
  upstream.pipe(res);
}

export const __apexProxyForTests = { requestUpstream, PROXY_FETCH_TIMEOUT_MS };

/**
 * Host-aware apex frontend reverse-proxy middleware. STRICT no-op (`next()`) for the
 * API host so every existing API route is untouched. Only GET/HEAD are proxied
 * (the static SPA has no write surface — the app writes to `api.mention.earth`);
 * any other method on the apex is answered `405`. `OPTIONS` never reaches here — the
 * CORS middleware short-circuits preflight upstream.
 */
export async function apexFrontendProxy(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!isApexHost(req)) {
    next();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).end();
    return;
  }
  await proxyToFrontend(req, res);
}
