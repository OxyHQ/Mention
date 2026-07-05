/**
 * Public web shell with per-request OpenGraph — the `bskyweb` model.
 *
 * A CF Origin Rule transparently routes `mention.earth/@*` and `mention.earth/p/*`
 * to this backend. For those paths we serve the static SPA shell HTML with
 * per-request OG/Twitter tags injected (so crawlers / link-unfurlers get a rich
 * preview) while browsers still boot the SPA normally. This replaces the OG
 * injection the retired Cloudflare Pages `_worker.js` used to do at the edge.
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
 */
import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { Post } from '../models/Post';
import { postHydrationService } from '../services/PostHydrationService';
import { logger } from '../utils/logger';
import {
  OgData,
  OxyProfileData,
  mapPostOg,
  mapProfileOg,
  renderShellWithOg,
} from '../services/webShellRenderer';

/** Frontend CDN origin the static SPA shell is fetched from (NOT the apex — that would loop the Origin Rule). */
const SHELL_ORIGIN = process.env.WEB_SHELL_ORIGIN || 'https://mention-frontend.pages.dev/';
/** How long a fetched shell is trusted before a background refresh. */
const SHELL_TTL_MS = 10 * 60 * 1000;
/** Hard timeout for the shell fetch — a slow CDN must never block a page. */
const SHELL_FETCH_TIMEOUT_MS = 5000;
/** Hard timeout for the per-request OG data fetch. */
const OG_FETCH_TIMEOUT_MS = 2500;

/** Oxy API origin — canonical profiles live here. */
const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';
/** Backend origin that serves the canonical ActivityPub actor. */
const API_ORIGIN = (process.env.MENTION_API_ORIGIN || 'https://api.mention.earth').replace(/\/+$/, '');
const AP_ACTOR_BASE = `${API_ORIGIN}/ap/users/`;

/** A LOCAL profile path: a single `@handle` segment with no second `@` and no sub-tab. */
const LOCAL_PROFILE_RE = /^\/@([^/@]+)$/;

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

/** Fetch + map a profile's OG data from the Oxy API. Returns null on any failure. */
async function fetchProfileOg(handle: string): Promise<OgData | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OG_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${OXY_API_URL}/profiles/username/${encodeURIComponent(handle)}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const json: { data?: OxyProfileData } = await response.json();
    return mapProfileOg(json?.data);
  } catch (error) {
    logger.debug('[webShell] Profile OG fetch failed', error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Hydrate + map a post's OG data in-process (same path as `GET /feed/item/:id`). Returns null on any failure. */
async function fetchPostOg(id: string): Promise<OgData | null> {
  try {
    if (!mongoose.isValidObjectId(id)) return null;
    const post = await Post.findById(id).maxTimeMS(OG_FETCH_TIMEOUT_MS).lean();
    if (!post) return null;
    // maxDepth:1 so boosts hydrate their original and link previews are included;
    // the OG mapping itself only reads the post's own top-level fields.
    const [hydrated] = await postHydrationService.hydratePosts([post], {
      maxDepth: 1,
      includeLinkMetadata: true,
    });
    if (!hydrated?.user) return null;
    return mapPostOg(hydrated, id);
  } catch (error) {
    logger.debug('[webShell] Post OG fetch failed', error);
    return null;
  }
}

/** Serve the shell with OG injected, overriding the API no-store default for these public per-URL pages. */
async function serveShell(res: Response, og: OgData | null): Promise<void> {
  const shell = (await getShell()) ?? FALLBACK_SHELL;
  res.status(200);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(renderShellWithOg(shell, og));
}

const router = Router();

// Profile: `/@handle` plus sub-tabs (`/@handle/media`, `/@handle/followers`, …).
// The captured group is the handle segment (`user` or `user@domain`).
router.get(/^\/@([^/]+)(?:\/.*)?$/, async (req: Request, res: Response) => {
  const handle = decodeURIComponent(req.params[0]);

  // AP content negotiation — only for a LOCAL single-segment profile URL.
  if (LOCAL_PROFILE_RE.test(req.path) && wantsActivityPub(req.headers.accept)) {
    res.setHeader('Vary', 'Accept');
    return res.redirect(302, AP_ACTOR_BASE + encodeURIComponent(handle));
  }

  res.setHeader('Vary', 'Accept');
  const og = await fetchProfileOg(handle);
  await serveShell(res, og);
});

// Post: `/p/<id>` (optional trailing slash). No AP case.
router.get(/^\/p\/([^/]+)\/?$/, async (req: Request, res: Response) => {
  const og = await fetchPostOg(req.params[0]);
  await serveShell(res, og);
});

export default router;
