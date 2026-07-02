/**
 * Cloudflare Pages — Advanced Mode Worker.
 *
 * The Mention frontend is a static Expo export deployed to Cloudflare Pages via
 * `wrangler pages deploy packages/frontend/dist`. With a direct upload, a
 * `functions/` directory inside the uploaded output is NOT compiled as Pages
 * Functions — the correct mechanism is a single `_worker.js` at the root of the
 * deployed dir (Advanced Mode). This file lives in `public/` so `expo export`
 * copies it to `dist/_worker.js`.
 *
 * This worker owns the apex (`mention.earth`) edge. It has three jobs:
 *
 * 1. ActivityPub content negotiation for LOCAL profile URLs. The fediverse
 *    discovers a Mention profile two ways:
 *     - by acct handle (`@user@mention.earth`) → webfinger → actor (already works).
 *     - by profile URL (`https://mention.earth/@user`) → the server must return the
 *       AP actor (or HTML linking to it). The Expo SPA only serves `index.html`, so
 *       URL-based discovery was failing for LOCAL profiles. When a fediverse server
 *       requests a LOCAL profile URL with an ActivityPub `Accept` header, we
 *       302-redirect to the canonical actor at `api.mention.earth/ap/users/<user>`.
 *
 * 2. AT Protocol BE-DISCOVERED bridge edge. The atproto bridge's read surface and
 *    handle resolution are served by the BACKEND (`api.mention.earth`), but the
 *    canonical contract advertises the apex host (`mention.earth`):
 *     - the user DID-document advertises `#atproto_pds` serviceEndpoint
 *       `https://mention.earth` (apex), so a foreign Bluesky AppView issues its
 *       `com.atproto.repo.*` / `com.atproto.sync.*` XRPC calls against
 *       `https://mention.earth/xrpc/*`.
 *     - apex handle resolution (`https://mention.earth/.well-known/atproto-did`)
 *       and the Relay `requestCrawl` host both resolve to this apex.
 *    The apex is served by THIS Cloudflare Pages worker, but the bridge handlers
 *    live on the backend. So for those apex paths we PROXY (origin-fetch, not a
 *    302) to `https://api.mention.earth`, preserving method + headers + body so
 *    POST XRPC calls survive. The original `Host` is forwarded as
 *    `X-Forwarded-Host` (the backend's atproto-did handler reads it).
 *
 * 3. ActivityPub apex PROXY (federation). Mention's ActivityPub actor IDs and inbox
 *    live on the APEX host (`mention.earth/ap/...`), not the backend — the HTTP
 *    signature a remote server (e.g. Mastodon) signs binds the request host
 *    `mention.earth`. A CF zone rule used to 301 `/ap/*` to `api.mention.earth`, but
 *    a 301 drops the POST body and changes the host, so Mastodon INBOX deliveries
 *    died on it. So the apex federation paths are PROXIED (origin-fetch, not a 302,
 *    all HTTP methods) to the backend with method + headers + body intact; the
 *    original apex host is forwarded as `X-Forwarded-Host` and the backend verifies
 *    the signature against that host. Paths: `/ap` + `/ap/*`,
 *    `/.well-known/webfinger`, `/.well-known/host-meta` (+`.json`),
 *    `/.well-known/nodeinfo`, `/nodeinfo/*`. The allowlist is explicit on
 *    `pathname` — we do NOT blanket-proxy `/.well-known/*`, so future static files
 *    (AASA, assetlinks.json) stay served by Pages.
 *
 * Everything else (human browsers, federated profiles, all other routes) is served
 * from static assets via `env.ASSETS.fetch`, which also honors the `_redirects`
 * SPA fallback (`/*  /index.html  200`). That SPA rewrite is exactly why the bridge
 * paths MUST be intercepted here first — otherwise `/xrpc/*` would be rewritten to
 * `index.html` and the AppView would get HTML instead of XRPC JSON.
 *
 * SAFE TO SHIP BEFORE GO-LIVE: while `ATPROTO_BRIDGE_ENABLED=false` the backend
 * bridge routes 404, so this forwarding just relays a 404 — no behavior change for
 * users. It only starts serving real data once the backend flag is flipped.
 *
 * NOTE — wildcard handle hosts are NOT handled here. atproto ALSO resolves a handle
 * via `https://<user>.mention.earth/.well-known/atproto-did`. That is a DIFFERENT
 * host (`<user>.mention.earth`), which this Pages project does not receive unless
 * `*.mention.earth` is explicitly routed to the backend at the DNS/CF layer. That
 * is an infra step, not worker code — see the go-live runbook.
 */

/** Canonical ActivityPub actor base for local users. */
const ACTOR_BASE = 'https://api.mention.earth/ap/users/';

/** Backend origin that serves the atproto bridge XRPC + apex handle resolution. */
const BACKEND_ORIGIN = 'https://api.mention.earth';

/** Local profile path: a single segment after `@`, with no second `@`. */
const LOCAL_PROFILE_PATH = /^\/@([^/@]+)$/;

/**
 * Apex paths owned by the atproto bridge that must be proxied to the backend.
 * The bridge serves only `com.atproto.*` XRPC, but forwarding the whole `/xrpc/`
 * prefix is correct: any unsupported XRPC method simply 404s at the backend. The
 * apex `.well-known/atproto-did` is the apex-host handle-resolution endpoint.
 */
function isBridgeBackendPath(pathname) {
  return pathname === '/.well-known/atproto-did' || pathname.startsWith('/xrpc/');
}

/**
 * Apex paths owned by ActivityPub federation that must be proxied to the backend.
 * These are the actor/inbox/discovery endpoints the backend mounts under the apex
 * host (`/ap`, webfinger, host-meta, nodeinfo). The allowlist is explicit — we do
 * NOT match all of `/.well-known/*`, so future static files (AASA, assetlinks.json)
 * keep being served by Pages. The `/ap` prefix check requires an exact match or a
 * `/`-delimited segment so an unrelated path like `/apply` never matches.
 */
function isFederationBackendPath(pathname) {
  return (
    pathname === '/ap' ||
    pathname.startsWith('/ap/') ||
    pathname === '/.well-known/webfinger' ||
    pathname === '/.well-known/host-meta' ||
    pathname === '/.well-known/host-meta.json' ||
    pathname === '/.well-known/nodeinfo' ||
    pathname.startsWith('/nodeinfo/')
  );
}

/**
 * Whether the `Accept` header asks for ActivityPub JSON. Mastodon may send
 * `application/ld+json; profile="https://www.w3.org/ns/activitystreams"`, so a
 * case-insensitive substring match on the JSON media subtypes is sufficient.
 */
function wantsActivityPub(accept) {
  if (!accept) return false;
  const value = accept.toLowerCase();
  return value.includes('activity+json') || value.includes('ld+json');
}

/**
 * Proxy an apex request to the backend origin, preserving the method, headers, and
 * body so POST calls (atproto XRPC, ActivityPub inbox deliveries) work. The path +
 * query string are kept verbatim; only the origin changes (`mention.earth` →
 * `api.mention.earth`). The original apex host is forwarded as `X-Forwarded-Host`
 * because backend handlers read it — the atproto-did handler derives the handle
 * from it, and ActivityPub signature verification binds it as the request host.
 */
function proxyToBackend(request) {
  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, BACKEND_ORIGIN);

  const headers = new Headers(request.headers);
  headers.set('X-Forwarded-Host', incoming.host);
  headers.set('X-Forwarded-Proto', 'https');

  // `duplex: 'half'` is required by the Fetch standard when forwarding a request
  // that may carry a streaming body (POST XRPC); harmless for bodyless GETs.
  return fetch(target.toString(), {
    method: request.method,
    headers,
    body: request.body,
    redirect: 'manual',
    duplex: 'half',
  });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    // 1. atproto bridge apex paths → proxy to the backend (preserve method/body).
    if (isBridgeBackendPath(pathname)) {
      return proxyToBackend(request);
    }

    // 2. ActivityPub federation apex paths (actor/inbox/webfinger/nodeinfo) → proxy
    // to the backend, preserving method + body so signed inbox POSTs verify.
    if (isFederationBackendPath(pathname)) {
      return proxyToBackend(request);
    }

    // 3. ActivityPub content negotiation for local profile URLs.
    const match = pathname.match(LOCAL_PROFILE_PATH);
    if (match && wantsActivityPub(request.headers.get('Accept'))) {
      const username = match[1];
      return new Response(null, {
        status: 302,
        headers: {
          Location: ACTOR_BASE + encodeURIComponent(username),
          // The redirect depends on the Accept header, so caches must vary on it.
          Vary: 'Accept',
        },
      });
    }

    // 4. Serve the static export (and the `_redirects` SPA fallback) for everything
    // else: human browsers, federated profiles, and all other routes.
    return env.ASSETS.fetch(request);
  },
};
