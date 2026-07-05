/**
 * Host-aware apex frontend reverse-proxy — the "bskyweb-full" model.
 *
 * When the frontend apex host (`mention.earth`) resolves to THIS backend (via the
 * ALB), every request that isn't a federation endpoint or an OG web-shell page
 * must be served the static Expo frontend. This middleware reverse-proxies those
 * apex requests to the frontend's static CDN (CloudFlare Pages) so we can point
 * `mention.earth` DNS at the ALB and retire the CF Pages `_worker.js`.
 *
 * It is a STRICT no-op for the API host (`api.mention.earth`): a non-apex request
 * calls `next()` untouched, so every existing API route behaves exactly as before.
 *
 * Mount order (see server.ts): it runs AFTER the federation routers (`/ap`,
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
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

/**
 * The frontend apex host (`mention.earth`). Derived from the SAME `MENTION_WEB_ORIGIN`
 * config the OG web-shell renderer uses, so the public web origin is defined in one
 * place. Only the bare hostname (no scheme / port) is compared.
 */
const APEX_HOST = extractHost(process.env.MENTION_WEB_ORIGIN || 'https://mention.earth');

/**
 * Static frontend CDN the SPA + its assets are proxied from (CloudFlare Pages).
 * Reuses `WEB_SHELL_ORIGIN` — the same origin the OG web-shell fetches its shell
 * from — so the CDN origin is configured in exactly one place. Trailing slash is
 * stripped so it concatenates cleanly with `req.originalUrl` (which starts `/`).
 */
const FRONTEND_CDN_ORIGIN = (process.env.WEB_SHELL_ORIGIN || 'https://mention-frontend.pages.dev').replace(/\/+$/, '');

/** Hard timeout for a single upstream proxy fetch. The apex must never hang on a slow CDN. */
const PROXY_FETCH_TIMEOUT_MS = 8000;

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

/** Reverse-proxy one apex request to the static frontend CDN. Fail-soft: never throws, never hangs. */
async function proxyToFrontend(req: Request, res: Response): Promise<void> {
  const target = `${FRONTEND_CDN_ORIGIN}${req.originalUrl}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_FETCH_TIMEOUT_MS);
  try {
    const upstream = await fetch(target, {
      method: req.method,
      // Request `identity` so the downstream compression middleware owns the final
      // transfer-encoding and no stale Content-Encoding/Content-Length is relayed.
      headers: {
        Accept: typeof req.headers.accept === 'string' ? req.headers.accept : '*/*',
        'Accept-Encoding': 'identity',
        'User-Agent': typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : 'Mention-apex-proxy',
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    // Pass the CDN's caching directives through, overriding the API `no-store`
    // default the CORS middleware set — this is what lets CF edge-cache the static
    // assets (`/_expo/static/*`, `/icons/*`, `/manifest.json`, `/favicon.ico`, …).
    const cacheControl = upstream.headers.get('cache-control');
    res.setHeader('Cache-Control', cacheControl ?? 'public, max-age=60');
    const etag = upstream.headers.get('etag');
    if (etag) res.setHeader('ETag', etag);
    const lastModified = upstream.headers.get('last-modified');
    if (lastModified) res.setHeader('Last-Modified', lastModified);

    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    // Buffer the body (SPA assets are small/static); Express + compression set the
    // final Content-Length/Content-Encoding. Do NOT rewrite the body — the SPA's
    // asset refs are root-relative and resolve against the apex correctly.
    const body = Buffer.from(await upstream.arrayBuffer());
    res.send(body);
  } catch (error) {
    if (res.headersSent) {
      res.end();
      return;
    }
    logger.warn(`[apexProxy] Upstream fetch failed for ${req.originalUrl}`, error);
    res.status(502);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(PROXY_FALLBACK_HTML);
  } finally {
    clearTimeout(timer);
  }
}

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
