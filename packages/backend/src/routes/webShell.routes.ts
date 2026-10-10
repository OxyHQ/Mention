/**
 * Public web shell with per-request OpenGraph — the `bskyweb` model.
 *
 * The BACKEND serves the whole apex: `server.ts` mounts the federation routers,
 * then this router, then `apexFrontendProxy` for everything else. So every apex
 * path already reaches here and adding one costs no infrastructure change — the
 * CF Origin Rule that used to route `/@*` and `/p/*` selectively was deleted with
 * the Cloudflare Pages worker on 2026-07-05. For the paths below we serve the
 * static SPA shell HTML with head metadata and JSON-LD
 * injected while leaving the application body unchanged.
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
import { externalIdentityReferenceSchema } from '@oxy.so/contracts';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { Router, type Request, type Response } from 'express';
import { config } from '../config';
import { loadPostRecord } from '../db/posts/postRepository';
import { loadNewestEligibleReplies } from '../services/PostRecentReplierService';
import type { PostRecord } from '../db/posts/postRecord';
import { postHydrationService } from '../services/PostHydrationService';
import { logger } from '../utils/logger';
import {
  type OgData,
  type OxyProfileData,
  type PostOgSafety,
  type ProfileSeoFacts,
  canonicalProfilePath,
  injectHeadHtml,
  mapHashtagOg,
  mapHomepageOg,
  mapPostOg,
  mapProfileOg,
  mapReplyComment,
  renderShellWithOg,
  buildShellBootstrapHtml,
  type ShellBootstrap,
} from '../services/webShellRenderer';
import { getShellCached } from '../services/webShellOgCache';
import { normalizeHashtag } from '../utils/textProcessing';
import { loadPublicProfileFacts } from '../services/publicProfileFacts';
import { requiresContentWarning, type FeedSafetyPostShape } from '../mtn/feed/feedSafety';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { webShellRateLimiter } from '../middleware/security';
import { measureOxyFetch } from '../utils/oxyMetrics';
import { isApexHost } from '../middleware/apexFrontendProxy';
import { getShell } from '../services/webShellDocument';
import {
  SitemapNotReadyError,
  hashtagHasListablePosts,
  mentionProfileSeoPolicy,
  type MentionProfileSeoPolicy,
  sitemapIndex,
  sitemapShard,
} from '../services/seoSitemap';

/** Hard timeout for the per-request OG data fetch. */
const OG_FETCH_TIMEOUT_MS = 2500;

/** Oxy API origin — canonical profiles live here. */
const OXY_API_URL = config.oxyApiUrl;
/** Backend origin that serves the canonical ActivityPub actor. */
const API_ORIGIN = config.web.apiOrigin;
const AP_ACTOR_BASE = `${config.deployment?.publicBaseUrl ?? API_ORIGIN}/ap/users/`;
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
    const path = `/profiles/username/${encodeURIComponent(handle)}`;
    const response = await measureOxyFetch('GET', path, () =>
      fetch(`${OXY_API_URL}${path}`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      }),
    );
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
async function cachedProfile(handle: string): Promise<OxyProfileData | null> {
  const profile = await getShellCached(`profile:${handle}`, () => fetchProfile(handle), {
    rethrow: true,
  });
  // Revalidate cached payloads too: transport lookups may return an Oxy person,
  // but only their canonical username or proven public aliases grant a URL.
  if (!profile?.username) return null;
  const normalize = (value: string) => value.trim().replace(/^@+/, '').toLowerCase();
  if (normalize(handle) === normalize(profile.username)) return profile;
  const aliases = externalIdentityReferenceSchema.array().safeParse(profile.externalIdentities);
  return aliases.success &&
    aliases.data.some((alias) => normalize(alias.canonicalAcct) === normalize(handle))
    ? profile
    : null;
}

/**
 * What Mention knows about a public profile beyond its Oxy payload — post count,
 * and a federated account's origin totals — for its structured data.
 *
 * Cached beside the profile itself, and FAIL-OPEN: these are descriptive facts,
 * so a failed read renders the page without them rather than turning an
 * indexable profile into a 503.
 */
async function profileSeoFacts(oxyUserId: string | undefined): Promise<ProfileSeoFacts> {
  if (!oxyUserId) return {};
  const facts = await getShellCached<ProfileSeoFacts>(`profile-facts:v1:${oxyUserId}`, async () => {
    const { counts, remote } = await loadPublicProfileFacts(oxyUserId);
    return { postsCount: counts.postsCount, ...(remote ? { remote } : {}) };
  });
  return facts ?? {};
}

async function isOxyAuthorPublic(oxyUserId: string): Promise<boolean> {
  const [user] = await getServiceOxyClient().users.getMany([oxyUserId]);
  if (!user?.username) return false;
  return Boolean(await fetchProfile(user.username));
}

/**
 * Whether a post's author may be shown to anyone — public on Mention AND on Oxy
 * — and whether search engines may index them, all read fresh for this request.
 * The two reads are independent, so they run together rather than one
 * round-trip after the other.
 */
async function authorSeoPolicy(oxyUserId: string): Promise<MentionProfileSeoPolicy> {
  if (!oxyUserId) return { visible: false, indexable: false };
  const [onMention, onOxy] = await Promise.all([
    mentionProfileSeoPolicy(oxyUserId),
    isOxyAuthorPublic(oxyUserId),
  ]);
  return { visible: onMention.visible && onOxy, indexable: onMention.indexable && onOxy };
}

/**
 * The page stays public, but an author who opted out of search engines is not
 * indexed. Never LOOSENS a policy: a gated post's `noindex,nofollow` stands.
 */
function withoutIndexing(og: OgData): OgData {
  return og.robots === 'index,follow' ? { ...og, robots: 'noindex,follow' } : og;
}

/**
 * Start the shell fetch while the route resolves its entity. `getShell` is
 * single-flight and cached, so this only matters when the process cache is
 * cold, where the shell download would otherwise wait for the entity reads.
 */
function warmShell(): void {
  void getShell();
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
function resolvePostOgSafety(post: PostSafetyRow, original: PostSafetyRow | null): PostOgSafety {
  const rows: (PostSafetyRow | null)[] = post.boostOf ? [post, original] : [post];

  const gated = rows.find((row) => requiresContentWarning(row));
  if (!gated) return { requiresWarning: false };

  const spoiler = gated.federation?.spoilerText;
  return {
    requiresWarning: true,
    contentWarning: typeof spoiler === 'string' && spoiler.trim() ? spoiler : undefined,
  };
}

/**
 * Hydrate + map a post's OG data in-process (same path as `GET /feed/item/:id`),
 * from the row and safety verdict this request already read. Returns null when
 * the post has no author to show.
 */
async function fetchPostOg(post: PostRecord, safety: PostOgSafety): Promise<OgData | null> {
  try {
    // maxDepth:1 so boosts hydrate their original and link previews are included;
    // the OG mapping itself only reads the post's own top-level fields.
    const [hydrated] = await postHydrationService.hydratePosts([post], {
      maxDepth: 1,
      includeLinkMetadata: true,
    });
    if (!hydrated?.user) return null;
    // The route already confirmed this author is public under a username, so a
    // nameless author here is a lookup that failed for this request — not a
    // card to cache for an hour as "Unknown user" with no profile to link.
    if (!getNormalizedUserHandle(hydrated.user)) throw new Error('post author did not resolve');
    return mapPostOg(hydrated, String(post.id), safety, { isBoost: Boolean(post.boostOf) });
  } catch (error) {
    logger.debug('[webShell] Post OG fetch failed', error);
    throw error;
  }
}

/** The newest replies a post page describes to search engines. */
const SEO_REPLY_LIMIT = 5;

/**
 * The newest public replies to a post, as the `Comment`s its structured data
 * lists.
 *
 * Read on every request, never from the hour-long card cache: whether a reply
 * may be shown is decided the way the post's own visibility is — fresh. Each
 * reply must be public and published, carry no content warning, and be by an
 * author who is public AND has not opted out of search engines; their words go
 * to a search engine only by their own leave.
 *
 * FAIL-OPEN: the replies describe the page, they are not the page, so a failed
 * read renders it without them rather than turning the post into a 503.
 */
async function postComments(postId: string): Promise<Record<string, unknown>[]> {
  try {
    const rows = (await loadNewestEligibleReplies(postId, SEO_REPLY_LIMIT)).filter(
      (row) => !requiresContentWarning(row),
    );
    if (!rows.length) return [];

    const authorIds = [...new Set(rows.map((row) => String(row.oxyUserId)))];
    const policies = new Map(
      await Promise.all(authorIds.map(async (id) => [id, await authorSeoPolicy(id)] as const)),
    );
    const shown = rows.filter((row) => policies.get(String(row.oxyUserId))?.indexable);
    if (!shown.length) return [];

    const hydrated = await postHydrationService.hydratePosts(shown, { maxDepth: 0 });
    return hydrated.flatMap((reply) => {
      const comment = reply ? mapReplyComment(reply, String(reply.id)) : null;
      return comment ? [comment] : [];
    });
  } catch (error) {
    logger.warn('[webShell] Post replies for structured data failed', {
      postId,
      ...describeShellFailure(error),
    });
    return [];
  }
}

/** The card with its replies attached, when the page is one a search engine indexes. */
async function withComments(og: OgData, postId: string): Promise<OgData> {
  if (og.robots !== 'index,follow' || !og.jsonLd || og.jsonLd.commentCount === 0) return og;
  const comment = await postComments(postId);
  return comment.length ? { ...og, jsonLd: { ...og.jsonLd, comment } } : og;
}

/**
 * A bounded description of a dependency failure, for the 503 paths below.
 *
 * Those catches used to be SILENT — a crawler sweeping deep links drew 48 503s
 * in twelve minutes with nothing in the log naming the path or the reason, and
 * `fetchPostOg`'s own report is at `debug`, which production does not emit. The
 * status is the part that decides what to do (a 429 is a rate budget, a 5xx is
 * an outage), and a plain `String(error)` prints `[object Object]` for the Oxy
 * SDK's plain-object rejections, so the fields are read defensively — off an
 * `Error` too, which is where an HTTP client usually hangs its status.
 */
function describeShellFailure(error: unknown): Record<string, unknown> {
  if (typeof error !== 'object' || error === null) return { reason: String(error) };

  // Read the same three fields whether or not this is an `Error`: an HTTP client
  // rejection is often an Error that ALSO carries `status`, and dropping it on
  // that branch would lose the one field that says "rate budget".
  const fields = error as {
    message?: unknown;
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
  };
  const status =
    typeof fields.status === 'number'
      ? fields.status
      : typeof fields.statusCode === 'number'
        ? fields.statusCode
        : undefined;
  const message =
    typeof fields.message === 'string' && fields.message.length > 0 ? fields.message : undefined;

  return {
    reason: message ?? 'unknown failure',
    ...(status !== undefined ? { status } : {}),
    ...(typeof fields.code === 'string' && fields.code.length > 0 ? { code: fields.code } : {}),
  };
}

/**
 * A profile or post preview: its metadata may be a minute old, and a crawler or a
 * shared-link unfurl hitting it again is served from cache.
 */
const ENTITY_PREVIEW_CACHE = 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600';

/**
 * The homepage is the app's front door, so it caches like the shell the Worker
 * serves for every other SPA path (`no-cache`): revalidated on every load. It
 * names the hashed JS of ONE release, and the entity-preview policy let a browser
 * keep booting the previous release for up to an hour after a deploy — which the
 * post-deploy apex smoke (`.github/scripts/smoke-frontend.sh`) exists to refuse.
 */
const HOMEPAGE_CACHE = 'no-cache';

/** Serve the shell with head hints + optional OG injected, overriding the API no-store default. */
async function serveShell(
  res: Response,
  og: OgData | null,
  status = 200,
  bootstrap?: ShellBootstrap,
  cacheControl: string = ENTITY_PREVIEW_CACHE,
): Promise<void> {
  const shell = (await getShell()) ?? FALLBACK_SHELL;
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', status === 200 ? cacheControl : 'no-store');
  const head = bootstrap ? HEAD_HINTS + buildShellBootstrapHtml(bootstrap) : HEAD_HINTS;
  res.send(renderShellWithOg(injectHeadHtml(shell, head), og));
}

function noindexPage(url: string, title: string, description: string): OgData {
  return {
    title,
    description,
    url,
    type: 'website',
    robots: 'noindex,nofollow',
  };
}

const router = Router();

// The single exported shell is also used by /explore and unknown paths. Keep
// homepage canonical/indexing metadata here, never in that shared fallback.
router.get('/', async (req, res, next) => {
  if (!isApexHost(req)) {
    next();
    return;
  }
  // Unlike an entity preview, home must not cache an empty app as a success.
  // getShell still returns a stale usable shell when a refresh fails.
  if (!(await getShell())) {
    res.status(502).set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
    res.type('text/plain').send('Application temporarily unavailable');
    return;
  }
  await serveShell(res, mapHomepageOg(), 200, undefined, HOMEPAGE_CACHE);
});

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

/**
 * Sitemaps are rebuilt every six hours (`SitemapBuildJob`), so a crawler or a
 * cache in front of us may keep one for an hour, and the CDN for six. The
 * build time is the Last-Modified, which with Express's own ETag lets a
 * revalidating crawler get a bodiless 304.
 */
function sendXml(res: Response, xml: string, builtAt: string | undefined): void {
  res.status(200);
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader(
    'Cache-Control',
    'public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400',
  );
  const lastModified = builtAt ? new Date(builtAt) : undefined;
  if (lastModified && !Number.isNaN(lastModified.getTime())) {
    res.setHeader('Last-Modified', lastModified.toUTCString());
  }
  // `res.send` sets the ETag and answers 304 itself when the request is fresh
  // against it or against the Last-Modified above.
  res.send(xml);
}

/** Nothing built yet (a fresh deployment or a flushed cache): ask the crawler to come back. */
function sitemapNotReady(res: Response): void {
  res.status(503).setHeader('Retry-After', '900').end();
}

router.get('/robots.txt', (_req, res) => {
  res.type('text/plain').setHeader('Cache-Control', 'public, max-age=3600, s-maxage=14400');
  res.send(ROBOTS_TXT);
});

router.get('/sitemap.xml', async (_req, res) => {
  try {
    const { xml, builtAt } = await sitemapIndex();
    sendXml(res, xml, builtAt);
  } catch (error) {
    if (!(error instanceof SitemapNotReadyError)) {
      logger.warn('[webShell] Failed to read the sitemap index', error);
    }
    sitemapNotReady(res);
  }
});

// The former numeric shards must never fall through to the SPA shell: crawlers
// can retain child sitemap URLs after the root index changes, and HTML at one of
// those URLs is reported as a malformed sitemap. Gone is the truthful response;
// the current root index is the only discovery entry point.
router.get(/^\/sitemaps\/(profiles|posts)-(\d+)\.xml$/, (_req, res) => {
  res.status(410);
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
  res.send(
    '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>',
  );
});

router.get(/^\/sitemaps\/(profiles|posts)-([0-9a-f]{2})-(\d+)\.xml$/, async (req, res) => {
  const kind = req.params[0] === 'profiles' ? 'profiles' : 'posts';
  const bucket = Number.parseInt(req.params[1], 16);
  const page = Number(req.params[2]);
  if (!Number.isSafeInteger(bucket) || !Number.isSafeInteger(page) || page < 0) {
    res.status(404).end();
    return;
  }
  try {
    // A cache read and nothing else: no request builds a sitemap (#1160).
    const shard = await sitemapShard(kind, { bucket, page });
    if (shard.status === 'absent') {
      res.status(404).setHeader('Cache-Control', 'public, max-age=3600').end();
      return;
    }
    sendXml(res, shard.xml, shard.builtAt);
  } catch (error) {
    if (!(error instanceof SitemapNotReadyError)) {
      logger.warn(`[webShell] Failed to read the ${kind} sitemap`, error);
    }
    sitemapNotReady(res);
  }
});

// Profile: `/@handle` plus sub-tabs (`/@handle/media`, `/@handle/followers`, …).
// The captured group is the handle segment (`user` or `user@domain`).
router.get(/^\/@([^/]+)(?:\/.*)?$/, async (req: Request, res: Response) => {
  warmShell();
  // Express 5 has already decoded the captured segment; decoding it again
  // threw on any handle with a literal `%`, so a bad link was a 500, not a 404.
  const handle = req.params[0];
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
  } catch (error) {
    logger.warn('[webShell] Profile page resolution failed', {
      path: req.path,
      ...describeShellFailure(error),
    });
    res.setHeader('Retry-After', '60');
    await serveShell(
      res,
      noindexPage(
        `${config.web.origin}${req.path}`,
        'Mention is temporarily unavailable',
        'Please try again shortly.',
      ),
      503,
    );
    return;
  }

  let policy: MentionProfileSeoPolicy = { visible: true, indexable: true };
  try {
    if (profile) {
      policy = await mentionProfileSeoPolicy(profile.id);
      if (!policy.visible) profile = null;
    }
  } catch (error) {
    logger.warn('[webShell] Profile visibility read failed', {
      path: req.path,
      ...describeShellFailure(error),
    });
    res.setHeader('Retry-After', '60');
    await serveShell(
      res,
      noindexPage(
        `${config.web.origin}${req.path}`,
        'Mention is temporarily unavailable',
        'Please try again shortly.',
      ),
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
      noindexPage(
        `${config.web.origin}${req.path}`,
        'Profile not found',
        'This profile is unavailable on Mention.',
      ),
      isProfileRoot ? 404 : 200,
    );
    return;
  }

  const mapped = mapProfileOg(profile, await profileSeoFacts(profile.id));
  // A sub-tab repeats the profile, so only the root is indexed.
  const og = mapped && (!isProfileRoot || !policy.indexable) ? withoutIndexing(mapped) : mapped;
  // The page's first request is this very lookup; hand the app the public
  // answer so its feed and design reads start with the route, not ~one
  // round-trip later. Only reached for a profile Mention publishes.
  await serveShell(res, og, 200, { profile: { handle, data: profile } });
});

// Channel: `/c/<handle>` (optional trailing slash).
//
// No AP branch. A channel IS an Oxy account, so its actor is the ordinary
// `/@<handle>` one — which is the URL webfinger and every remote instance
// already resolve, and the URL this backend advertises as the actor's `url`.
// Adding a second AP entry point would give one actor two profile URLs and leave
// remote software to guess which is canonical.
router.get(/^\/c\/([^/]+)\/?$/, async (req: Request, res: Response) => {
  warmShell();
  // Express 5 has already decoded the captured segment; decoding it again
  // threw on any handle with a literal `%`, so a bad link was a 500, not a 404.
  const handle = req.params[0];
  // The same profile resolution the `/@handle` route uses, so a channel's card is
  // built from the same payload and `og:url` comes back as `/c/<handle>` from the
  // ONE definition of that (`canonicalProfilePath`).
  try {
    const profile = await cachedProfile(handle);
    const policy = profile ? await mentionProfileSeoPolicy(profile.id) : undefined;
    if (!profile || !policy?.visible) {
      await serveShell(
        res,
        noindexPage(
          `${config.web.origin}${req.path}`,
          'Channel not found',
          'This channel is unavailable on Mention.',
        ),
        404,
      );
      return;
    }
    if (profile.kind !== 'channel' && profile.username) {
      res.redirect(301, canonicalProfilePath(profile));
      return;
    }
    const og = mapProfileOg(profile, await profileSeoFacts(profile.id));
    await serveShell(res, og && !policy.indexable ? withoutIndexing(og) : og);
  } catch (error) {
    logger.warn('[webShell] Channel page resolution failed', {
      path: req.path,
      ...describeShellFailure(error),
    });
    res.setHeader('Retry-After', '60');
    await serveShell(
      res,
      noindexPage(
        `${config.web.origin}${req.path}`,
        'Mention is temporarily unavailable',
        'Please try again shortly.',
      ),
      503,
    );
  }
});

// Hashtag: `/hashtag/<tag>` on the apex. The tag is normalized the way posts
// store it, so every spelling shares one canonical URL.
router.get(
  /^\/hashtag\/([^/]+)\/?$/,
  webShellRateLimiter,
  async (req: Request, res: Response, next) => {
    if (!isApexHost(req)) {
      next();
      return;
    }
    warmShell();
    let raw = '';
    try {
      raw = decodeURIComponent(req.params[0]);
    } catch {
      // A malformed escape names no hashtag.
    }
    const tag = normalizeHashtag(raw);
    if (!tag) {
      await serveShell(
        res,
        noindexPage(
          `${config.web.origin}${req.path}`,
          'Hashtag not found',
          'This hashtag is unavailable on Mention.',
        ),
        404,
      );
      return;
    }
    try {
      const found = await getShellCached(
        `hashtag:v1:${tag}`,
        async () => ({ listable: await hashtagHasListablePosts(tag) }),
        { rethrow: true },
      );
      await serveShell(res, mapHashtagOg(tag, found?.listable ?? false));
    } catch (error) {
      logger.warn('[webShell] Hashtag page resolution failed', {
        path: req.path,
        ...describeShellFailure(error),
      });
      res.setHeader('Retry-After', '60');
      await serveShell(
        res,
        noindexPage(
          `${config.web.origin}${req.path}`,
          'Mention is temporarily unavailable',
          'Please try again shortly.',
        ),
        503,
      );
    }
  },
);

// Post: `/p/<id>` (optional trailing slash). No AP case.
router.get(/^\/p\/([^/]+)\/?$/, webShellRateLimiter, async (req: Request, res: Response) => {
  warmShell();
  const id = req.params[0];
  try {
    // No id-shape guard: `posts.id` is `text`, so an arbitrary path segment
    // matches no row and yields `null`, while an ObjectId test would refuse to
    // render an OG card for any post created since the cutover.
    const post = await loadPostRecord(id);
    if (!post) {
      await serveShell(
        res,
        noindexPage(
          `${config.web.origin}${req.path}`,
          'Post not found',
          'This post is unavailable on Mention.',
        ),
        404,
      );
      return;
    }

    const authorId = post.oxyUserId ? String(post.oxyUserId) : '';
    const isPublic = post.visibility === 'public' && post.status === 'published';
    // Every read below is this request's own and current; nothing is taken from
    // a cache before the visibility decisions. Independent reads run together,
    // and each row is read once and handed on rather than read again.
    const [author, original] = isPublic
      ? await Promise.all([
          authorSeoPolicy(authorId),
          post.boostOf ? loadPostRecord(String(post.boostOf)) : Promise.resolve(null),
        ])
      : [undefined, null];
    if (!isPublic || !author?.visible) {
      await serveShell(
        res,
        noindexPage(
          `${config.web.origin}${req.path}`,
          'Post unavailable',
          'Sign in to Mention if you have access to this post.',
        ),
      );
      return;
    }

    // A boost's rendered body comes from its original. Check current visibility
    // for both rows before reading any cached representation.
    let indexable = author.indexable;
    if (post.boostOf) {
      const originalAuthor = original?.oxyUserId ? String(original.oxyUserId) : '';
      const originalPolicy =
        original && original.visibility === 'public' && original.status === 'published'
          ? await authorSeoPolicy(originalAuthor)
          : undefined;
      if (!originalPolicy?.visible) {
        await serveShell(
          res,
          noindexPage(
            `${config.web.origin}${req.path}`,
            'Post unavailable',
            'This post is unavailable on Mention.',
          ),
        );
        return;
      }
      // Its words are the original author's, so their choice governs too.
      indexable = indexable && originalPolicy.indexable;
    }

    const safety = resolvePostOgSafety(post, original);
    // Never serve a previously cached safe body after a sensitivity change.
    // A gated post is re-rendered from the current row on every request.
    const og = safety.requiresWarning
      ? await fetchPostOg(post, safety)
      : await getShellCached(`post:semantic-v2:${id}`, () => fetchPostOg(post, safety), {
          rethrow: true,
        });
    if (!og) {
      await serveShell(
        res,
        noindexPage(
          `${config.web.origin}${req.path}`,
          'Post not found',
          'This post is unavailable on Mention.',
        ),
        404,
      );
      return;
    }
    await serveShell(
      res,
      indexable ? await withComments(og, String(post.id)) : withoutIndexing(og),
    );
  } catch (error) {
    logger.warn('[webShell] Post page resolution failed', {
      path: req.path,
      ...describeShellFailure(error),
    });
    res.setHeader('Retry-After', '60');
    await serveShell(
      res,
      noindexPage(
        `${config.web.origin}${req.path}`,
        'Mention is temporarily unavailable',
        'Please try again shortly.',
      ),
      503,
    );
  }
});

export default router;
