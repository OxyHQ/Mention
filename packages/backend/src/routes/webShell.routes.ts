/**
 * Public web shell with per-request OpenGraph — the `bskyweb` model.
 *
 * The BACKEND serves the whole apex: `server.ts` mounts the federation routers,
 * then this router, then `apexFrontendProxy` for everything else. So every apex
 * path already reaches here and adding one costs no infrastructure change — the
 * CF Origin Rule that used to route `/@*` and `/p/*` selectively was deleted with
 * the Cloudflare Pages worker on 2026-07-05. For the paths below we serve the
 * static SPA shell HTML with per-request OG/Twitter tags injected (so crawlers /
 * link-unfurlers get a rich preview) while browsers still boot the SPA normally.
 * This replaces the OG injection the retired `_worker.js` used to do at the edge.
 *
 * The shell (Expo's single static `index.html`) is fetched ONCE from the frontend
 * CDN and cached in-memory — it only changes on a frontend deploy. Root-relative
 * asset refs in that HTML (`/_expo/static/...`) resolve against the apex, which
 * CF still serves from Pages, so booting the SPA works unchanged.
 *
 * Everything here is PUBLIC (no auth) and fail-open: a slow/broken OG fetch or a
 * missing entity serves the plain shell (no OG) rather than failing the page.
 *
 * AP content negotiation: a request for a LOCAL profile URL (`/@user`, single
 * segment, no `@domain`, no sub-tab) that `Accept`s ActivityPub is 302-redirected
 * to the canonical actor — a GET-only redirect, mirroring the worker. All other
 * requests (browsers, crawlers, federated handles, sub-tabs) get the shell.
 *
 * Channel content negotiation: a channel is an Oxy account whose page lives at
 * `/c/<handle>`, so a LOCAL profile URL naming one is 302-redirected there. That
 * branch is deliberately BELOW the ActivityPub one — an AP consumer asking for
 * `/@channel` must reach the actor, and a redirect chain is exactly what
 * Mastodon's strict redirector refuses.
 */
import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { config } from '../config';
import { Post } from '../models/Post';
import { postHydrationService } from '../services/PostHydrationService';
import { logger } from '../utils/logger';
import {
  OgData,
  OxyProfileData,
  PostOgSafety,
  injectHeadHtml,
  mapPostOg,
  mapProfileOg,
  renderShellWithOg,
} from '../services/webShellRenderer';
import { getShellCached } from '../services/webShellOgCache';
import { requiresContentWarning, type FeedSafetyPostShape } from '../mtn/feed/feedSafety';

/** Frontend CDN origin the static SPA shell is fetched from (NOT the apex — that would loop the Origin Rule). */
const SHELL_ORIGIN = `${config.web.shellOrigin}/`;
/** How long a fetched shell is trusted before a background refresh. */
const SHELL_TTL_MS = 10 * 60 * 1000;
/** Hard timeout for the shell fetch — a slow CDN must never block a page. */
const SHELL_FETCH_TIMEOUT_MS = 5000;
/** Hard timeout for the per-request OG data fetch. */
const OG_FETCH_TIMEOUT_MS = 2500;

/** Oxy API origin — canonical profiles live here. */
const OXY_API_URL = config.oxyApiUrl;
/** Backend origin that serves the canonical ActivityPub actor. */
const API_ORIGIN = config.web.apiOrigin;
const AP_ACTOR_BASE = `${API_ORIGIN}/ap/users/`;
/** Oxy file/media CDN origin — canonical avatars/media are served from here (see CSP `cloud.oxy.so`). */
const OXY_MEDIA_CDN_ORIGIN = config.web.oxyMediaCdnOrigin;

/**
 * Static `<head>` resource hints injected into every deep-link shell so the
 * browser opens TCP+TLS to the API and the media CDN in parallel with parsing the
 * SPA bundle (the SPA fetches feed/profile data from the API and images from the
 * CDN on mount). Crawlers ignore these; they cost browsers nothing but save a
 * round trip.
 */
const HEAD_HINTS =
  `<link rel="preconnect" href="${API_ORIGIN}" crossorigin>` +
  `<link rel="preconnect" href="${OXY_MEDIA_CDN_ORIGIN}" crossorigin>`;

/**
 * Link-unfurlers / crawlers that need server-rendered OG tags because they do NOT
 * execute the SPA's client-side JS. Real browsers are served the shell WITHOUT a
 * blocking OG fetch (the SPA mounts the meta on hydration), so only these UAs pay
 * the OG-resolution cost — and it is Redis-cached with stale-while-revalidate.
 */
const CRAWLER_UA_RE =
  /bot|crawler|spider|crawling|facebookexternalhit|facebot|twitterbot|slackbot|slack-imgproxy|discordbot|whatsapp|telegram|linkedinbot|pinterest|redditbot|embedly|quora link preview|showyoubot|outbrain|vkshare|w3c_validator|applebot|googlebot|bingbot|yandex|baiduspider|duckduckbot|mastodon|pleroma|akkoma|misskey|iframely|skypeuripreview|nuzzel|google-inspectiontool|metainspector|opengraph|unfurl|preview|flipboard|tumblr|mediapartners/i;

/** Whether the request is a crawler/unfurler that needs server-rendered OG tags. */
function isCrawler(userAgent: string | undefined): boolean {
  return typeof userAgent === 'string' && CRAWLER_UA_RE.test(userAgent);
}

/** A LOCAL profile path: a single `@handle` segment with no second `@` and no sub-tab. */
const LOCAL_PROFILE_RE = /^\/@([^/@]+)$/;
/** Where a channel account's page lives. Mirrors `canonicalProfilePath`. */
const CHANNEL_PATH_PREFIX = '/c/';

/**
 * Minimal valid HTML served only in the extreme edge case where the shell CDN is
 * unreachable AND we have never cached a copy. It carries the OG tags (so
 * crawlers still get a preview) and never 500s; browsers hitting this rare state
 * simply reload once the CDN recovers.
 */
const FALLBACK_SHELL =
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Mention</title>' +
  '</head><body><div id="root"></div></body></html>';

interface ShellCache {
  html: string;
  fetchedAt: number;
}

let shellCache: ShellCache | null = null;
let shellInFlight: Promise<string | null> | null = null;

/** Fetch the static shell HTML with a hard timeout. Returns null on any failure (never throws). */
async function fetchShellHtml(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHELL_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(SHELL_ORIGIN, {
      headers: { Accept: 'text/html' },
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.warn(`[webShell] Shell fetch returned ${response.status}`);
      return null;
    }
    return await response.text();
  } catch (error) {
    logger.warn('[webShell] Shell fetch failed', error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Refresh the cached shell, de-duplicating concurrent refreshes into one fetch. */
function refreshShell(): Promise<string | null> {
  if (!shellInFlight) {
    shellInFlight = fetchShellHtml()
      .then((html) => {
        if (html) shellCache = { html, fetchedAt: Date.now() };
        return shellCache?.html ?? null;
      })
      .finally(() => {
        shellInFlight = null;
      });
  }
  return shellInFlight;
}

/**
 * Return the SPA shell, aggressively cached. A fresh copy is served from memory;
 * a stale copy is served immediately while a background refresh runs
 * (stale-while-revalidate); a cold cache awaits the first successful fetch.
 * Returns null only when there is no cache and the fetch failed.
 */
async function getShell(): Promise<string | null> {
  if (shellCache && Date.now() - shellCache.fetchedAt < SHELL_TTL_MS) {
    return shellCache.html;
  }
  if (shellCache) {
    void refreshShell();
    return shellCache.html;
  }
  return refreshShell();
}

/** Whether the `Accept` header asks for ActivityPub JSON (Mastodon may send `ld+json`). */
function wantsActivityPub(accept: string | undefined): boolean {
  if (!accept) return false;
  const value = accept.toLowerCase();
  return value.includes('activity+json') || value.includes('ld+json');
}

/**
 * Fetch a profile from the Oxy API. Returns null on any failure.
 *
 * The RAW payload rather than the mapped OG, because two callers read it: the OG
 * card, and the channel redirect below — which a BROWSER needs too, so it cannot
 * ride on the crawler-only OG path. One fetch, one cache entry, both answers.
 */
async function fetchProfile(handle: string): Promise<OxyProfileData | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OG_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${OXY_API_URL}/profiles/username/${encodeURIComponent(handle)}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const json = (await response.json()) as { data?: OxyProfileData };
    return json?.data ?? null;
  } catch (error) {
    logger.debug('[webShell] Profile fetch failed', error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The cached profile for a handle, SWR-backed. Null when unknown or unreachable. */
function cachedProfile(handle: string): Promise<OxyProfileData | null> {
  return getShellCached(`profile:${handle}`, () => fetchProfile(handle));
}

/** The raw post fields the OG safety verdict reads. */
type PostSafetyRow = FeedSafetyPostShape & { boostOf?: unknown };

/**
 * The safety verdict for a post's OG card, read from the RAW rows (the hydrated DTO
 * exposes only a subset of the sensitivity signals).
 *
 * A BOOST is checked against its original as well as itself: a boost's own body is
 * empty, so `mapPostOg` draws its description from the boosted original — which means
 * a boost of a sensitive post would otherwise unfurl that post's text while carrying
 * no signal of its own.
 */
async function resolvePostOgSafety(post: PostSafetyRow): Promise<PostOgSafety> {
  const rows: Array<PostSafetyRow | null> = [post];

  if (post.boostOf) {
    rows.push(await Post.findById(String(post.boostOf)).maxTimeMS(OG_FETCH_TIMEOUT_MS).lean());
  }

  const gated = rows.find((row) => requiresContentWarning(row));
  if (!gated) return { requiresWarning: false };

  const spoiler = gated.federation?.spoilerText;
  return {
    requiresWarning: true,
    contentWarning: typeof spoiler === 'string' && spoiler.trim() ? spoiler : undefined,
  };
}

/** Hydrate + map a post's OG data in-process (same path as `GET /feed/item/:id`). Returns null on any failure. */
async function fetchPostOg(id: string): Promise<OgData | null> {
  try {
    if (!mongoose.isValidObjectId(id)) return null;
    const post = await Post.findById(id).maxTimeMS(OG_FETCH_TIMEOUT_MS).lean();
    if (!post) return null;
    // maxDepth:1 so boosts hydrate their original and link previews are included;
    // the OG mapping itself only reads the post's own top-level fields.
    const [hydrated, safety] = await Promise.all([
      postHydrationService.hydratePosts([post], {
        maxDepth: 1,
        includeLinkMetadata: true,
      }).then((posts) => posts[0]),
      resolvePostOgSafety(post),
    ]);
    if (!hydrated?.user) return null;
    return mapPostOg(hydrated, id, safety);
  } catch (error) {
    logger.debug('[webShell] Post OG fetch failed', error);
    return null;
  }
}

/** Serve the shell with head hints + optional OG injected, overriding the API no-store default. */
async function serveShell(res: Response, og: OgData | null): Promise<void> {
  const shell = (await getShell()) ?? FALLBACK_SHELL;
  res.status(200);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Per-URL page whose body depends on User-Agent (crawler OG vs plain browser
  // shell) — `private` so a shared cache never serves one audience's variant to
  // the other; the browser still caches its own copy for 5 minutes.
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(renderShellWithOg(injectHeadHtml(shell, HEAD_HINTS), og));
}

const router = Router();

// Profile: `/@handle` plus sub-tabs (`/@handle/media`, `/@handle/followers`, …).
// The captured group is the handle segment (`user` or `user@domain`).
router.get(/^\/@([^/]+)(?:\/.*)?$/, async (req: Request, res: Response) => {
  const handle = decodeURIComponent(req.params[0]);
  const isLocalProfileUrl = LOCAL_PROFILE_RE.test(req.path);

  // AP content negotiation — only for a LOCAL single-segment profile URL, and
  // FIRST: an ActivityPub consumer must reach the actor in one hop. Mastodon's
  // redirector is strict and does not re-sign, so a chain through the channel
  // redirect below would silently kill inbound federation.
  if (isLocalProfileUrl && wantsActivityPub(req.headers.accept)) {
    res.setHeader('Vary', 'Accept');
    return res.redirect(302, AP_ACTOR_BASE + encodeURIComponent(handle));
  }

  // The body varies by Accept (AP redirect above) and User-Agent (crawlers get
  // server-side OG; browsers get the plain shell + client-side OG).
  res.setHeader('Vary', 'Accept, User-Agent');

  // ONE profile resolution, read by both decisions below.
  //
  // A browser on a plain `/@handle` now pays it too, which it did not before: the
  // channel redirect is what makes the URL right, and a browser is exactly who
  // follows it. It is SWR-cached per handle (fresh 5 min, stale-while-revalidate
  // for an hour), so it is normally a Redis read; a miss or an Oxy outage answers
  // null, which simply does not redirect and shows no card. A browser on a
  // SUB-TAB skips it entirely — no channel lives there and no browser needs OG.
  const wantsOg = isCrawler(req.headers['user-agent']);
  const profile = isLocalProfileUrl || wantsOg ? await cachedProfile(handle) : null;

  // A channel account's page is `/c/<handle>`, not `/@<handle>`.
  if (isLocalProfileUrl && profile?.kind === 'channel' && profile.username) {
    return res.redirect(302, CHANNEL_PATH_PREFIX + encodeURIComponent(profile.username));
  }

  // Only crawlers/unfurlers need OG server-side; a browser boots the SPA which
  // sets its own meta, so it is served the shell immediately.
  await serveShell(res, wantsOg ? mapProfileOg(profile) : null);
});

// Channel: `/c/<handle>` (optional trailing slash).
//
// No AP branch. A channel IS an Oxy account, so its actor is the ordinary
// `/@<handle>` one — which is the URL webfinger and every remote instance
// already resolve, and the URL this backend advertises as the actor's `url`.
// Adding a second AP entry point would give one actor two profile URLs and leave
// remote software to guess which is canonical.
router.get(/^\/c\/([^/]+)\/?$/, async (req: Request, res: Response) => {
  const handle = decodeURIComponent(req.params[0]);
  res.setHeader('Vary', 'User-Agent');
  // The same profile resolution the `/@handle` route uses, so a channel's card is
  // built from the same payload and `og:url` comes back as `/c/<handle>` from the
  // ONE definition of that (`canonicalProfilePath`).
  const og = isCrawler(req.headers['user-agent'])
    ? mapProfileOg(await cachedProfile(handle))
    : null;
  await serveShell(res, og);
});

// Post: `/p/<id>` (optional trailing slash). No AP case.
router.get(/^\/p\/([^/]+)\/?$/, async (req: Request, res: Response) => {
  const id = req.params[0];
  // Body varies by User-Agent (crawler OG vs plain browser shell).
  res.setHeader('Vary', 'User-Agent');
  // Browsers get the shell immediately; only crawlers pay the Mongo hydration to
  // resolve post OG, cached in Redis with stale-while-revalidate.
  const og = isCrawler(req.headers['user-agent'])
    ? await getShellCached(`post:${id}`, () => fetchPostOg(id))
    : null;
  await serveShell(res, og);
});

export default router;
