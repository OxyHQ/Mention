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

/* global HTMLRewriter -- provided by the Cloudflare Pages runtime (no import). */

/** Canonical ActivityPub actor base for local users. */
const ACTOR_BASE = 'https://api.mention.earth/ap/users/';

/** Backend origin that serves the atproto bridge XRPC + apex handle resolution. */
const BACKEND_ORIGIN = 'https://api.mention.earth';

/** Oxy API origin — canonical profiles live here, NOT on `api.mention.earth`. */
const OXY_API_ORIGIN = 'https://api.oxy.so';

/** By-id media CDN — bare Oxy file ids resolve to `${CLOUD_ORIGIN}/<id>`. */
const CLOUD_ORIGIN = 'https://cloud.oxy.so';

/** Canonical web origin used for `og:url` (the apex this worker serves). */
const WEB_ORIGIN = 'https://mention.earth';

/**
 * PWA/head markup that Expo's `output: "single"` build drops: `web.manifest` and
 * `web.meta` in app.config are NOT wired into the bare exported `index.html`, so
 * the manifest link + apple/theme metas never reach the browser (no installable
 * PWA, and the Web Share Target → /compose flow is dead without a linked manifest).
 * The manifest file itself is a static asset at `public/manifest.json`; this links
 * it and restores the essential PWA head. Injected into every HTML page.
 */
const PWA_HEAD =
  '<link rel="manifest" href="/manifest.json">' +
  '<meta name="theme-color" content="#0B0B0F">' +
  '<meta name="apple-mobile-web-app-capable" content="yes">' +
  '<meta name="apple-mobile-web-app-title" content="Mention">' +
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">';

/** Hard timeout for the per-request OG data fetch — a slow API must never block a page. */
const OG_FETCH_TIMEOUT_MS = 2500;

/** Profile URL: `/@handle` plus sub-tabs (`/@handle/media`, …). Handle = `user` or `user@domain`. */
const OG_PROFILE_PATH = /^\/@([^/]+)(?:\/|$)/;

/** Post URL: `/p/<id>` (optional trailing slash). */
const POST_PATH = /^\/p\/([^/]+)\/?$/;

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

/*
 * ---------------------------------------------------------------------------
 * Pre-hydration background + per-request OpenGraph/Twitter meta injection.
 *
 * WHY: an Expo single-output web build ships ONE static `index.html` with a
 * bare `<title>Mention</title>` and no per-URL meta — the SPA fills content in
 * only after the JS boots. That means (a) a hard reload flashes the browser's
 * default white page before React paints, and (b) crawlers / link-unfurlers
 * (Slack, Discord, iMessage, Mastodon, Twitter) that never run JS see the same
 * empty shell for every profile and post — no rich preview.
 *
 * This is the CF-edge equivalent of Bluesky's `bskyweb` server, which injects
 * per-request OG tags into the SPA HTML. We do the same with `HTMLRewriter`
 * (a CF runtime global — no import): inject a dark `<style>` into every page,
 * and for `/@handle` and `/p/:id` fetch the public OG data and inject meta.
 *
 * FAIL-OPEN is the contract: if the OG fetch errors, times out, or returns a
 * non-OK/non-JSON body we serve the page normally (still with the dark bg). A
 * slow or broken API must never block or fail a page load.
 * ---------------------------------------------------------------------------
 */

/**
 * Escape a string for safe interpolation into HTML attribute/text contexts.
 * Handles the minimum dangerous set (`& < > "`). Non-string input → empty.
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Fetch public OG JSON with an abort-timeout and edge caching. Returns the
 * parsed body, or `null` on ANY failure (timeout, network, non-OK, bad JSON).
 * Never throws — callers rely on `null` to fail open.
 */
async function fetchOgJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OG_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      // Edge-cache the public OG payload for 5 minutes — crawlers hammer these.
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build OG data for a profile URL (`/@handle`). Works for local and federated
 * handles — both resolve through the Oxy API. Returns `{title, description,
 * image, url, type}` or `null` when the handle is unknown / the fetch failed.
 */
async function buildProfileOg(handle) {
  const json = await fetchOgJson(
    `${OXY_API_ORIGIN}/profiles/username/${encodeURIComponent(handle)}`,
  );
  const data = json?.data;
  if (!data?.username) return null;

  const username = data.username;
  const displayName = data.name?.displayName;
  const avatar = data.avatar;

  let image;
  if (typeof avatar === 'string' && avatar.length > 0) {
    // Federated avatars are absolute URLs; local avatars are bare Oxy file ids.
    image = avatar.startsWith('http')
      ? avatar
      : `${CLOUD_ORIGIN}/${encodeURIComponent(avatar)}?variant=thumb`;
  }

  return {
    title: displayName
      ? `${displayName} (@${username}) on Mention`
      : `@${username} on Mention`,
    description: (data.bio || data.description || '').trim(),
    image,
    url: `${WEB_ORIGIN}/@${username}`,
    type: 'profile',
  };
}

/**
 * Build OG data for a post URL (`/p/:id`). The feed-item endpoint returns the
 * post object at the TOP LEVEL (not wrapped in `{data}`). Returns `{title,
 * description, image, url, type}` or `null` when the post is missing.
 */
async function buildPostOg(id) {
  const post = await fetchOgJson(
    `${BACKEND_ORIGIN}/feed/item/${encodeURIComponent(id)}`,
  );
  if (!post?.user) return null;

  const user = post.user;
  const author = user.displayName || `@${user.handle}`;
  const media = post.content?.media?.[0];

  const image =
    media?.url ||
    media?.thumbUrl ||
    media?.posterUrl ||
    post.linkPreview?.image ||
    user.avatarUrl ||
    undefined;

  return {
    title: `${author} on Mention`,
    description: (post.content?.text || '').trim().slice(0, 200),
    image,
    url: `${WEB_ORIGIN}/p/${id}`,
    type: 'article',
  };
}

/**
 * Render the OG/Twitter `<meta>` block for injection into `<head>`. Every
 * dynamic value is HTML-escaped. `og:image`/`twitter:image` are emitted only
 * when an image is present (a preview card without an image is still valid).
 */
function ogMetaHtml(og) {
  const title = escapeHtml(og.title);
  const description = escapeHtml(og.description);
  const url = escapeHtml(og.url);
  const type = escapeHtml(og.type);

  let html =
    `<meta property="og:type" content="${type}">` +
    `<meta property="og:site_name" content="Mention">` +
    `<meta property="og:url" content="${url}">` +
    `<meta property="og:title" content="${title}">` +
    `<meta property="og:description" content="${description}">` +
    `<meta name="twitter:card" content="summary_large_image">` +
    `<meta name="twitter:title" content="${title}">` +
    `<meta name="twitter:description" content="${description}">` +
    `<meta name="description" content="${description}">`;

  if (og.image) {
    const image = escapeHtml(og.image);
    html +=
      `<meta property="og:image" content="${image}">` +
      `<meta name="twitter:image" content="${image}">`;
  }

  return html;
}

/**
 * Stream the HTML response through `HTMLRewriter`, injecting the PWA head (manifest
 * link + apple/theme metas Expo drops) into every page and — when `og` is present —
 * the OG meta block + a replaced `<title>`. Non-HTML responses never reach here.
 * The pre-hydration dark background is NOT injected here: it lives in `global.css`
 * as a static render-blocking rule, so the white flash is fixed even when this
 * worker isn't running.
 */
function transformHtml(response, og) {
  const rewriter = new HTMLRewriter().on('head', {
    element(element) {
      element.append(PWA_HEAD, { html: true });
      if (og) element.append(ogMetaHtml(og), { html: true });
    },
  });

  // Replace the static `<title>Mention</title>` rather than appending a second one.
  if (og) {
    rewriter.on('title', {
      element(element) {
        element.setInnerContent(og.title);
      },
    });
  }

  return rewriter.transform(response);
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
    // else: human browsers, federated profiles, and all other routes. Only GET
    // `text/html` responses get the preboot-bg + OG-meta injection; every other
    // asset (JS/CSS/images/fonts) passes through untouched. OG fetching is fully
    // fail-open — any error falls back to serving the page with just the bg.
    const assetResponse = await env.ASSETS.fetch(request);
    if (request.method !== 'GET') return assetResponse;
    const contentType = assetResponse.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return assetResponse;

    let og = null;
    const profileMatch = pathname.match(OG_PROFILE_PATH);
    const postMatch = pathname.match(POST_PATH);
    try {
      if (profileMatch) og = await buildProfileOg(decodeURIComponent(profileMatch[1]));
      else if (postMatch) og = await buildPostOg(postMatch[1]);
    } catch {
      og = null;
    }

    return transformHtml(assetResponse, og);
  },
};
