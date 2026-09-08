/**
 * Public web shell with per-request OpenGraph — the `bskyweb` model.
 *
 * The BACKEND serves the whole apex: `server.ts` mounts the federation routers,
 * then this router, then `apexFrontendProxy` for everything else. So every apex
 * path already reaches here and adding one costs no infrastructure change — the
 * CF Origin Rule that used to route `/@*` and `/p/*` selectively was deleted with
 * the Cloudflare Pages worker on 2026-07-05. For the paths below we serve the
 * static SPA shell HTML with metadata, JSON-LD, and semantic public content
 * injected while browsers still boot the SPA normally.
 * This replaces the OG injection the retired `_worker.js` used to do at the edge.
 *
 * The shell (Expo's single static `index.html`) is fetched ONCE from the frontend
 * CDN and cached in-memory — it only changes on a frontend deploy. Root-relative
 * asset refs in that HTML (`/_expo/static/...`) resolve against the apex, which
 * CF still serves from Pages, so booting the SPA works unchanged.
 *
 * Everything here is PUBLIC (no auth). Missing entities return real 404s and a
 * transient dependency failure returns 503, avoiding generic-200 soft 404s.
 *
 * AP content negotiation: a request for a LOCAL profile URL (`/@user`, single
 * segment, no `@domain`, no sub-tab) that `Accept`s ActivityPub is 302-redirected
 * to the canonical actor — a GET-only redirect, mirroring the worker. All other
 * requests (browsers, crawlers, federated handles, sub-tabs) get the shell.
 *
 * Channel content negotiation: a channel is an Oxy account whose page lives at
 * `/c/<handle>`, so a profile URL naming one is permanently redirected there. That
 * branch is deliberately BELOW the ActivityPub one — an AP consumer asking for
 * `/@channel` must reach the actor, and a redirect chain is exactly what
 * Mastodon's strict redirector refuses.
 */
import { Router, Request, Response } from 'express';
import { config } from '../config';
import { loadPostRecord } from '../db/posts/postRepository';
import { postHydrationService } from '../services/PostHydrationService';
import { logger } from '../utils/logger';
import {
  OgData,
  OxyProfileData,
  PostOgSafety,
  canonicalProfilePath,
  escapeHtml,
  injectHeadHtml,
  mapPostOg,
  mapProfileOg,
  renderShellWithOg,
} from '../services/webShellRenderer';
import { getShellCached } from '../services/webShellOgCache';
import { requiresContentWarning, type FeedSafetyPostShape } from '../mtn/feed/feedSafety';
import { getDb } from '../db/postgres';
import { userSettings } from '../db/schema/userProfile';
import { eq } from 'drizzle-orm';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import {
  postSitemap,
  profileSitemap,
  renderSitemapIndex,
  sitemapPageCounts,
} from '../services/seoSitemap';

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

/** A LOCAL profile path: a single `@handle` segment with no second `@` and no sub-tab. */
const LOCAL_PROFILE_RE = /^\/@([^/@]+)$/;
/** Any root profile URL, including federated handles containing a second `@`. */
const PROFILE_ROOT_RE = /^\/@([^/]+)$/;
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
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Oxy profile lookup failed (${response.status})`);
    const json = (await response.json()) as { data?: OxyProfileData };
    return json?.data ?? null;
  } catch (error) {
    logger.debug('[webShell] Profile fetch failed', error);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** The cached profile for a handle, SWR-backed. Null when unknown or unreachable. */
function cachedProfile(handle: string): Promise<OxyProfileData | null> {
  return getShellCached(`profile:${handle}`, () => fetchProfile(handle), { rethrow: true });
}

async function isMentionProfilePublic(profile: OxyProfileData): Promise<boolean> {
  if (!profile.id) return true;
  const [settings] = await getDb()
    .select({ visibility: userSettings.privacyProfileVisibility })
    .from(userSettings)
    .where(eq(userSettings.oxyUserId, profile.id))
    .limit(1);
  return !settings || settings.visibility === 'public';
}

async function isOxyAuthorPublic(oxyUserId: string): Promise<boolean> {
  const [user] = await getServiceOxyClient().getUsersByIds([oxyUserId]);
  if (!user?.username) return false;
  return Boolean(await fetchProfile(user.username));
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
    rows.push(await loadPostRecord(String(post.boostOf)));
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
    // No id-shape guard: `posts.id` is `text`, so an arbitrary path segment
    // matches no row and yields the same `null` the ObjectId test used to — while
    // an ObjectId test would have refused to render an OG card for any post
    // created since the cutover.
    const post = await loadPostRecord(id);
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
    throw error;
  }
}

/** Serve the shell with head hints + optional OG injected, overriding the API no-store default. */
async function serveShell(res: Response, og: OgData | null, status = 200): Promise<void> {
  const shell = (await getShell()) ?? FALLBACK_SHELL;
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader(
    'Cache-Control',
    status === 200
      ? 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600'
      : 'no-store',
  );
  res.send(renderShellWithOg(injectHeadHtml(shell, HEAD_HINTS), og));
}

function noindexPage(url: string, title: string, description: string): OgData {
  return {
    title,
    description,
    url,
    type: 'website',
    robots: 'noindex,nofollow',
    bodyHtml: `<main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></main>`,
  };
}

const router = Router();

const ROBOTS_TXT = `User-agent: *
Content-Signal: search=yes,ai-train=no,use=reference
Allow: /

User-agent: Amazonbot
Disallow: /
User-agent: Applebot-Extended
Disallow: /
User-agent: Bytespider
Disallow: /
User-agent: CCBot
Disallow: /
User-agent: ClaudeBot
Disallow: /
User-agent: Google-Extended
Disallow: /
User-agent: GPTBot
Disallow: /
User-agent: meta-externalagent
Disallow: /

Sitemap: ${config.web.origin}/sitemap.xml
`;

function sendXml(res: Response, xml: string): void {
  res.status(200);
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');
  res.send(xml);
}

router.get('/robots.txt', (_req, res) => {
  res.type('text/plain').setHeader('Cache-Control', 'public, max-age=3600, s-maxage=14400');
  res.send(ROBOTS_TXT);
});

router.get('/sitemap.xml', async (_req, res) => {
  try {
    const counts = await sitemapPageCounts();
    sendXml(res, renderSitemapIndex(counts.profiles, counts.posts));
  } catch (error) {
    logger.warn('[webShell] Failed to build sitemap index', error);
    res.status(503).setHeader('Retry-After', '300').end();
  }
});

router.get(/^\/sitemaps\/(profiles|posts)-(\d+)\.xml$/, async (req, res) => {
  const kind = req.params[0];
  const page = Number(req.params[1]);
  if (!Number.isSafeInteger(page) || page < 0) {
    res.status(404).end();
    return;
  }
  try {
    sendXml(res, kind === 'profiles' ? await profileSitemap(page) : await postSitemap(page));
  } catch (error) {
    logger.warn(`[webShell] Failed to build ${kind} sitemap`, error);
    res.status(503).setHeader('Retry-After', '300').end();
  }
});

// Profile: `/@handle` plus sub-tabs (`/@handle/media`, `/@handle/followers`, …).
// The captured group is the handle segment (`user` or `user@domain`).
router.get(/^\/@([^/]+)(?:\/.*)?$/, async (req: Request, res: Response) => {
  const handle = decodeURIComponent(req.params[0]);
  const isLocalProfileUrl = LOCAL_PROFILE_RE.test(req.path);
  const isProfileRoot = PROFILE_ROOT_RE.test(req.path);

  // AP content negotiation — only for a LOCAL single-segment profile URL, and
  // FIRST: an ActivityPub consumer must reach the actor in one hop. Mastodon's
  // redirector is strict and does not re-sign, so a chain through the channel
  // redirect below would silently kill inbound federation.
  if (isLocalProfileUrl && wantsActivityPub(req.headers.accept)) {
    res.setHeader('Vary', 'Accept');
    return res.redirect(302, AP_ACTOR_BASE + encodeURIComponent(handle));
  }

  res.setHeader('Vary', 'Accept');

  // ONE profile resolution, read by both decisions below.
  //
  // Every HTML client gets the same public representation. Resolution is
  // SWR-cached per handle, so the normal path is a Redis read.
  let profile: OxyProfileData | null;
  try {
    profile = await cachedProfile(handle);
  } catch {
    res.setHeader('Retry-After', '60');
    await serveShell(
      res,
      noindexPage(`${config.web.origin}${req.path}`, 'Mention is temporarily unavailable', 'Please try again shortly.'),
      503,
    );
    return;
  }

  try {
    if (profile && !(await isMentionProfilePublic(profile))) profile = null;
  } catch {
    res.setHeader('Retry-After', '60');
    await serveShell(
      res,
      noindexPage(`${config.web.origin}${req.path}`, 'Mention is temporarily unavailable', 'Please try again shortly.'),
      503,
    );
    return;
  }

  // A channel account's page is `/c/<handle>`, not `/@<handle>`.
  if (isProfileRoot && profile?.kind === 'channel' && profile.username) {
    return res.redirect(301, CHANNEL_PATH_PREFIX + encodeURIComponent(profile.username));
  }

  if (!profile) {
    await serveShell(
      res,
      noindexPage(`${config.web.origin}${req.path}`, 'Profile not found', 'This profile is unavailable on Mention.'),
      isProfileRoot ? 404 : 200,
    );
    return;
  }

  const og = mapProfileOg(profile);
  if (og && !isProfileRoot) og.robots = 'noindex,follow';
  await serveShell(res, og);
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
  // The same profile resolution the `/@handle` route uses, so a channel's card is
  // built from the same payload and `og:url` comes back as `/c/<handle>` from the
  // ONE definition of that (`canonicalProfilePath`).
  try {
    const profile = await cachedProfile(handle);
    if (!profile || !(await isMentionProfilePublic(profile))) {
      await serveShell(res, noindexPage(`${config.web.origin}${req.path}`, 'Channel not found', 'This channel is unavailable on Mention.'), 404);
      return;
    }
    if (profile.kind !== 'channel' && profile.username) {
      res.redirect(301, canonicalProfilePath(profile));
      return;
    }
    await serveShell(res, mapProfileOg(profile));
  } catch {
    res.setHeader('Retry-After', '60');
    await serveShell(res, noindexPage(`${config.web.origin}${req.path}`, 'Mention is temporarily unavailable', 'Please try again shortly.'), 503);
  }
});

// Post: `/p/<id>` (optional trailing slash). No AP case.
router.get(/^\/p\/([^/]+)\/?$/, async (req: Request, res: Response) => {
  const id = req.params[0];
  try {
    const post = await loadPostRecord(id);
    if (!post) {
      await serveShell(res, noindexPage(`${config.web.origin}${req.path}`, 'Post not found', 'This post is unavailable on Mention.'), 404);
      return;
    }

    const authorId = post.oxyUserId ? String(post.oxyUserId) : '';
    const isPublic = post.visibility === 'public' && post.status === 'published';
    const authorIsPublic = Boolean(authorId)
      && await isMentionProfilePublic({ id: authorId })
      && await isOxyAuthorPublic(authorId);
    if (!isPublic || !authorIsPublic) {
      await serveShell(
        res,
        noindexPage(`${config.web.origin}${req.path}`, 'Post unavailable', 'Sign in to Mention if you have access to this post.'),
      );
      return;
    }

    const safety = await resolvePostOgSafety(post);
    // Never serve a previously cached safe body after a sensitivity change.
    // A gated post is re-rendered from the current row on every request.
    const og = safety.requiresWarning
      ? await fetchPostOg(id)
      : await getShellCached(`post:${id}`, () => fetchPostOg(id), { rethrow: true });
    if (!og) {
      await serveShell(res, noindexPage(`${config.web.origin}${req.path}`, 'Post not found', 'This post is unavailable on Mention.'), 404);
      return;
    }
    await serveShell(res, og);
  } catch {
    res.setHeader('Retry-After', '60');
    await serveShell(res, noindexPage(`${config.web.origin}${req.path}`, 'Mention is temporarily unavailable', 'Please try again shortly.'), 503);
  }
});

export default router;
