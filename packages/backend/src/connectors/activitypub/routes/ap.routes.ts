import { Router, Request, Response } from 'express';
import { isValidObjectId } from 'mongoose';
import { logger } from '../../../utils/logger';
import { activityPubConnector } from '../ActivityPubConnector';
import { verifyHttpSignature, getPublicKey } from '../crypto';
import { Post } from '../../../models/Post';
import UserSettings from '../../../models/UserSettings';
import FederatedFollow from '../../../models/FederatedFollow';
import {
  FEDERATION_DOMAIN,
  FEDERATION_ENABLED,
  AP_CONTEXT,
  AP_CONTENT_TYPE,
  isActivityPubAccept,
  actorUrl,
  inboxUrl,
  outboxUrl,
  featuredUrl,
  followersUrl,
  followingUrl,
  sharedInboxUrl,
  resolveOxyUser,
} from '../constants';
import { ChronoCursor } from '../../../mtn/feed/CursorBuilder';
import rateLimit from 'express-rate-limit';
import { RedisStore } from '../../../middleware/rateLimitStore';
import { hashedIpKey } from '../../../utils/ipKey';
import { enqueueInboxActivity } from '../../../queue/producers';
import { resolveAvatarUrl, resolveMediaRef } from '../../../utils/mediaResolver';
import { isFediverseSharingEnabledFromUser, getFediverseSharingStateByUsername } from '../../../services/fediverseSharing';

const router = Router();

// Rate-limit AP protocol endpoints (30 req/min per IP — prevent abuse as DDoS vector)
const apRateLimiter = rateLimit({
  store: new RedisStore({ prefix: 'rate-limit:ap:', windowMs: 60 * 1000 }),
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too Many Requests' },
  // AP endpoints are anonymous (remote servers), so key by an HMAC of the
  // IPv6-subnet-normalized IP — the raw address must never reach a Redis key.
  keyGenerator: (req: Request) => hashedIpKey(req),
});
router.use(apRateLimiter);

/**
 * Content negotiation: check if request wants ActivityPub JSON-LD.
 */
function wantsActivityPub(req: Request): boolean {
  return isActivityPubAccept(req.headers.accept);
}

/** Extract username param safely as a string. */
function getUsername(req: Request): string {
  const val = req.params.username;
  return typeof val === 'string' ? val : Array.isArray(val) ? val[0] : String(val);
}

/** Fields of the resolved Oxy user the actor document reads. */
interface ActorUserView {
  _id?: string | null;
  id?: string | null;
  name?: { displayName?: string | null } | null;
  bio?: string | null;
  avatar?: string | null;
  createdAt?: string | null;
}

/** Map common image extensions to a MIME type for an actor image `mediaType`. */
const IMAGE_MEDIA_TYPE_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
};

/** True when `value` is an absolute `http(s)` URL. */
function isAbsoluteHttpUrl(value: string): boolean {
  try {
    return /^https?:$/i.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Build an ActivityPub `Image` object from an already-absolute URL, deriving
 * `mediaType` from the URL extension when recognizable (a bare `Image` with a
 * `url` is spec-valid, so an unknown extension simply omits `mediaType` rather
 * than asserting a wrong one). Shared by the actor `icon` (avatar) and `image`
 * (profile banner) builders.
 */
function apImageObject(url: string): { type: 'Image'; url: string; mediaType?: string } {
  let extension: string | undefined;
  try {
    extension = new URL(url).pathname.split('.').pop()?.toLowerCase();
  } catch {
    extension = url.split('?')[0]?.split('.').pop()?.toLowerCase();
  }
  const mediaType = extension ? IMAGE_MEDIA_TYPE_BY_EXT[extension] : undefined;
  return mediaType ? { type: 'Image', url, mediaType } : { type: 'Image', url };
}

/**
 * Build the actor `icon` (avatar) object for ActivityPub.
 *
 * The avatar reference stored on the Oxy user may be a raw Oxy file id (e.g.
 * `69b80c09a08af16d4b871195`) or an absolute URL. ActivityPub consumers such as
 * Mastodon validate that `icon.url` is an absolute URL and REJECT the entire
 * actor document when it is not — so a raw file id here makes the account
 * undiscoverable. We therefore resolve the reference through the same
 * server-authoritative `resolveAvatarUrl` mechanism the rest of the API uses
 * (Oxy file id → absolute Oxy asset stream URL; external URL → proxied through
 * our own origin), and only emit `icon` when that yields a real absolute URL.
 *
 * Derives `mediaType` from the resolved URL extension when recognizable;
 * otherwise the `mediaType` is omitted rather than asserting a wrong type (a
 * bare `Image` with `url` is spec-valid).
 *
 * Returns undefined when there is no avatar or no absolute URL can be produced —
 * Mastodon is fine with an avatar-less actor, but a non-absolute url breaks it.
 */
function buildActorIcon(avatar: string | null | undefined): { type: 'Image'; url: string; mediaType?: string } | undefined {
  if (!avatar) return undefined;

  // Resolve a raw Oxy file id (or external URL) to a final, absolute URL. If the
  // reference was already an absolute http(s) URL, `resolveAvatarUrl` returns an
  // absolute URL too (verbatim for our own origins, proxied for external CDNs).
  const resolved = resolveAvatarUrl(avatar);

  // Guard the absolute-URL invariant: if resolution failed or degraded to a
  // non-absolute passthrough (e.g. an unresolvable id), OMIT `icon` entirely
  // rather than emit a value that would make Mastodon reject the actor.
  if (!resolved || !isAbsoluteHttpUrl(resolved)) {
    logger.warn(`[Federation] Omitting actor icon — avatar did not resolve to an absolute URL (ref: ${avatar})`);
    return undefined;
  }

  return apImageObject(resolved);
}

/**
 * Build the actor `image` (profile banner/header) object for ActivityPub.
 *
 * Mastodon renders the AP `image` property as the profile HEADER banner — a
 * Mention user's banner is otherwise invisible across the fediverse. The banner
 * reference lives in Mention's own `UserSettings.profileHeaderImage` (a raw Oxy
 * file id or an absolute URL), the same field the profile-design endpoint reads
 * and `mirrorFederatedBanner` writes for the inbound direction. It is resolved
 * through the canonical media chokepoint (`resolveMediaRef`) to a final absolute
 * URL — an Oxy file id → CDN URL, an external URL → proxied through our origin —
 * mirroring {@link buildActorIcon}'s absolute-URL invariant.
 *
 * Returns undefined when there is no banner or none can be resolved to an
 * absolute URL, so callers omit the field cleanly.
 */
function buildActorImage(banner: string | null | undefined): { type: 'Image'; url: string; mediaType?: string } | undefined {
  if (!banner) return undefined;

  const resolved = resolveMediaRef(banner).url;
  if (!resolved || !isAbsoluteHttpUrl(resolved)) {
    logger.warn(`[Federation] Omitting actor image — banner did not resolve to an absolute URL (ref: ${banner})`);
    return undefined;
  }

  return apImageObject(resolved);
}

/**
 * GET /ap/users/:username — ActivityPub Actor endpoint
 */
router.get('/users/:username', async (req: Request, res: Response) => {
  if (!FEDERATION_ENABLED) return res.status(404).json({ error: 'Federation disabled' });

  if (!wantsActivityPub(req)) {
    // Redirect to frontend profile if not an AP request
    return res.redirect(`https://${FEDERATION_DOMAIN}/@${getUsername(req)}`);
  }

  const username = getUsername(req);

  try {
    // Instance actor: a special server-level actor used for signed fetches.
    // It has no Oxy user — serve it directly from the key pair collection.
    if (username === 'instance') {
      const publicKey = await getPublicKey('instance');
      const actorObject = {
        '@context': AP_CONTEXT,
        id: actorUrl('instance'),
        type: 'Application',
        preferredUsername: 'instance',
        name: FEDERATION_DOMAIN,
        summary: '',
        url: `https://${FEDERATION_DOMAIN}`,
        inbox: inboxUrl('instance'),
        outbox: outboxUrl('instance'),
        endpoints: { sharedInbox: sharedInboxUrl() },
        manuallyApprovesFollowers: false,
        discoverable: false,
        publicKey: {
          id: publicKey.keyId,
          owner: actorUrl('instance'),
          publicKeyPem: publicKey.publicKeyPem,
        },
      };
      res.set('Content-Type', AP_CONTENT_TYPE);
      res.set('Cache-Control', 'max-age=1800');
      return res.json(actorObject);
    }

    const resolved = await resolveOxyUser(username);
    if (!resolved) return res.status(404).json({ error: 'User not found' });

    const user = resolved as ActorUserView;

    // Sharing OFF must be indistinguishable from a nonexistent user — same
    // 404 body, no separate error code. Derived from the user object already
    // resolved above (no second Oxy lookup).
    if (!isFediverseSharingEnabledFromUser(user)) {
      return res.status(404).json({ error: 'User not found' });
    }

    const publicKey = await getPublicKey(username);

    // The profile banner lives in Mention's own per-user settings (not the Oxy
    // user DTO), keyed by the resolved Oxy user id — the same field the
    // profile-design endpoint reads. Advertise it as the AP `image` (Mastodon
    // header). Absent settings / banner cleanly omits the field.
    const userId = user._id || user.id;
    const settings = userId
      ? await UserSettings.findOne({ oxyUserId: String(userId) }, { profileHeaderImage: 1 })
          .lean<{ profileHeaderImage?: string } | null>()
      : null;

    // Canonical display name is owned by the Oxy API (`name.displayName`). Do not
    // recompute it from first/last/full/username. Fall back to the username only
    // if the API somehow omitted it, so `name` is never empty.
    const displayName = user.name?.displayName || username;

    const actorObject: Record<string, unknown> = {
      '@context': AP_CONTEXT,
      id: actorUrl(username),
      type: 'Person',
      preferredUsername: username,
      name: displayName,
      summary: user.bio || '',
      url: `https://${FEDERATION_DOMAIN}/@${username}`,
      inbox: inboxUrl(username),
      outbox: outboxUrl(username),
      featured: featuredUrl(username),
      followers: followersUrl(username),
      following: followingUrl(username),
      endpoints: { sharedInbox: sharedInboxUrl() },
      discoverable: true,
      manuallyApprovesFollowers: false,
      icon: buildActorIcon(user.avatar),
      image: buildActorImage(settings?.profileHeaderImage),
      publicKey: {
        id: publicKey.keyId,
        owner: actorUrl(username),
        publicKeyPem: publicKey.publicKeyPem,
      },
    };

    // `published` (account creation date) is advertised when the API provides it.
    if (user.createdAt) {
      actorObject.published = new Date(user.createdAt).toISOString();
    }

    res.set('Content-Type', AP_CONTENT_TYPE);
    res.set('Cache-Control', 'max-age=1800');
    return res.json(actorObject);
  } catch (err) {
    logger.error('Actor endpoint error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /ap/users/:username/inbox — User inbox
 */
router.post('/users/:username/inbox', async (req: Request, res: Response) => {
  if (!FEDERATION_ENABLED) return res.status(404).json({ error: 'Federation disabled' });

  // Sharing OFF (or a bogus `:username` — this route otherwise never
  // validated it against the shared inbox's generic path) must be
  // indistinguishable from a nonexistent user — same 404 body, no separate
  // error code. An Oxy OUTAGE ('unavailable') is deliberately NOT 404'd:
  // this is a POST delivery, and a 4xx response makes the remote server drop
  // it permanently rather than retry, so availability wins over gating
  // freshness here — the activity is enqueued/processed and any consent
  // decision is re-checked downstream by the id-based (fail-open) gates.
  const username = getUsername(req);
  const sharingState = await getFediverseSharingStateByUsername(username);
  if (sharingState === 'disabled' || sharingState === 'unknown-user') {
    return res.status(404).json({ error: 'User not found' });
  }

  return handleInbox(req, res);
});

/**
 * POST /ap/inbox — Shared inbox
 */
router.post('/inbox', async (req: Request, res: Response) => {
  if (!FEDERATION_ENABLED) return res.status(404).json({ error: 'Federation disabled' });
  return handleInbox(req, res);
});

/**
 * Common inbox handler with HTTP signature verification.
 */
async function handleInbox(req: Request, res: Response): Promise<Response> {
  try {
    // Verify HTTP signature (use originalUrl to avoid proxy path mangling)
    const { verified, actorUri, reason: signatureError } = await verifyHttpSignature(
      {
        method: req.method,
        path: req.originalUrl || req.path,
        headers: req.headers as Record<string, string | string[] | undefined>,
        body: req.rawBody ?? req.body,
      },
      (keyId) => activityPubConnector.fetchPublicKey(keyId),
    );

    if (!verified || !actorUri) {
      logger.debug('Inbox: HTTP signature verification failed', { reason: signatureError });
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const activity = req.body;
    if (!activity || !activity.type) {
      return res.status(400).json({ error: 'Invalid activity' });
    }

    // Verify the actor in the activity matches the signature
    const activityActor = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
    if (activityActor !== actorUri) {
      logger.debug(`Inbox: Actor mismatch. Signed: ${actorUri}, Activity: ${activityActor}`);
      return res.status(403).json({ error: 'Actor mismatch' });
    }

    // Process asynchronously — return 202 Accepted immediately.
    // Durable path: enqueue onto BullMQ keyed by the activity id (dedupe). When
    // the queue is unavailable (Redis not configured) OR the activity has no
    // stable id to dedupe on, fall back to inline fire-and-forget processing so
    // the activity is never dropped.
    let enqueued = false;
    try {
      enqueued = await enqueueInboxActivity({ activity, verifiedActorUri: actorUri });
    } catch (err) {
      logger.error('Failed to enqueue inbox activity — processing inline:', err);
      enqueued = false;
    }

    if (!enqueued) {
      activityPubConnector.processInboxActivity(activity, actorUri).catch((err) => {
        logger.error('Error processing inbox activity:', err);
      });
    }

    return res.status(202).json({ status: 'accepted' });
  } catch (err) {
    logger.error('Inbox error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /ap/users/:username/outbox — User's public posts as OrderedCollection
 */
router.get('/users/:username/outbox', async (req: Request, res: Response) => {
  if (!FEDERATION_ENABLED) return res.status(404).json({ error: 'Federation disabled' });

  const username = getUsername(req);
  const page = req.query.page === 'true';

  try {
    const user = await resolveOxyUser(username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Sharing OFF must be indistinguishable from a nonexistent user — same
    // 404 body, no separate error code.
    if (!isFediverseSharingEnabledFromUser(user)) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userId = user._id || user.id;
    const totalPosts = await Post.countDocuments({
      oxyUserId: userId,
      visibility: 'public',
      status: 'published',
      parentPostId: null,
    });

    if (!page) {
      // Return collection summary
      res.set('Content-Type', AP_CONTENT_TYPE);
      return res.json({
        '@context': AP_CONTEXT,
        id: outboxUrl(username),
        type: 'OrderedCollection',
        totalItems: totalPosts,
        first: `${outboxUrl(username)}?page=true`,
      });
    }

    // Return paginated items. Keyset pagination by (createdAt, _id) — the same
    // ChronoCursor axis the native feeds use — so EVERY post is reachable by
    // walking `next`. Previously the page returned only the first 20 items with
    // no `next`, silently stranding every post beyond the first page from any AP
    // consumer that paginates (e.g. a 42-post outbox exposed only 20). Overfetch
    // one extra row to detect whether a further page exists without a second
    // count query.
    const PAGE_SIZE = 20;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

    const pageMatch: Record<string, unknown> = {
      oxyUserId: userId,
      visibility: 'public',
      status: 'published',
      parentPostId: null,
    };
    ChronoCursor.applyToQuery(pageMatch, cursor);

    const overfetched = await Post.find(pageMatch)
      .sort({ createdAt: -1, _id: -1 })
      .limit(PAGE_SIZE + 1)
      .lean();

    const hasNext = overfetched.length > PAGE_SIZE;
    const pagePosts = hasNext ? overfetched.slice(0, PAGE_SIZE) : overfetched;

    // Reuse the SINGLE Note builder that push delivery uses, so outbox backfill
    // (Mastodon ≥4.4 imports up to 20 items on discovery) carries the same
    // fidelity as pushed posts: canonical url, hashtag `tag`s, and media
    // `attachment`s. One implementation for both paths.
    const items = pagePosts.map((post) => activityPubConnector.buildCreateNoteActivity(post, username));

    const pageId = cursor
      ? `${outboxUrl(username)}?page=true&cursor=${encodeURIComponent(cursor)}`
      : `${outboxUrl(username)}?page=true`;

    const pageResponse: Record<string, unknown> = {
      '@context': AP_CONTEXT,
      id: pageId,
      type: 'OrderedCollectionPage',
      partOf: outboxUrl(username),
      totalItems: totalPosts,
      orderedItems: items,
    };

    if (hasNext) {
      const lastPost = pagePosts[pagePosts.length - 1];
      const nextCursor = ChronoCursor.build(String(lastPost._id), lastPost.createdAt);
      pageResponse.next = `${outboxUrl(username)}?page=true&cursor=${encodeURIComponent(nextCursor)}`;
    }

    res.set('Content-Type', AP_CONTENT_TYPE);
    return res.json(pageResponse);
  } catch (err) {
    logger.error('Outbox endpoint error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /ap/users/:username/collections/featured — Featured collection (pinned posts)
 *
 * Mastodon does NOT backfill a freshly-discovered remote account's timeline from
 * the `outbox`; on profile view it fetches this `featured` collection (advertised
 * on the actor) and renders those PINNED posts. Without it a discovered Mention
 * profile shows avatar/banner/post-count but ZERO posts. This is the fix.
 *
 * Returns a NON-paginated `OrderedCollection` whose `orderedItems` are the user's
 * pinned posts as bare AP `Note` objects (NOT `Create` activities) — reusing the
 * SAME Note builder as the outbox/push/dereference paths (unwrapping the `Create`
 * envelope), so featured Notes carry identical fidelity. Ownership + visibility
 * exactly mirror the outbox filter (public + published + top-level, owned by the
 * named user), plus `metadata.isPinned`; newest-first. Same fediverse-sharing
 * consent gate + 404-when-off behavior as the sibling AP surfaces.
 */
router.get('/users/:username/collections/featured', async (req: Request, res: Response) => {
  if (!FEDERATION_ENABLED) return res.status(404).json({ error: 'Federation disabled' });

  const username = getUsername(req);

  try {
    const user = await resolveOxyUser(username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Sharing OFF must be indistinguishable from a nonexistent user — same
    // 404 body, no separate error code.
    if (!isFediverseSharingEnabledFromUser(user)) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userId = user._id || user.id;

    // Only PUBLIC + PUBLISHED top-level pinned posts are exposed — identical
    // ownership/visibility filter to the outbox, narrowed to pinned. Mastodon
    // caps featured display at ~5, but we serve all pinned posts newest-first;
    // FEATURED_LIMIT is a defensive upper bound.
    const FEATURED_LIMIT = 20;
    const pinnedPosts = await Post.find({
      oxyUserId: userId,
      'metadata.isPinned': true,
      visibility: 'public',
      status: 'published',
      parentPostId: null,
    })
      .sort({ createdAt: -1, _id: -1 })
      .limit(FEATURED_LIMIT)
      .lean();

    // Build via the shared Note path, then unwrap the Create envelope: a featured
    // collection contains bare Note OBJECTS, carrying no per-item `@context` (the
    // collection's top-level `@context` covers them).
    const items = pinnedPosts.map(
      (post) => activityPubConnector.buildCreateNoteActivity(post, username).object as Record<string, unknown>,
    );

    res.set('Content-Type', AP_CONTENT_TYPE);
    res.set('Cache-Control', 'max-age=300');
    return res.json({
      '@context': AP_CONTEXT,
      id: featuredUrl(username),
      type: 'OrderedCollection',
      totalItems: items.length,
      orderedItems: items,
    });
  } catch (err) {
    logger.error('Featured collection endpoint error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /ap/users/:username/posts/:id — Dereference a single post as an AP Note.
 *
 * The Note id minted everywhere (push delivery, outbox, `buildCreateNoteActivity`)
 * is `https://<domain>/ap/users/<username>/posts/<postId>`, so this route MUST
 * serve that object for Mastodon's URL-search import of an old post to work — the
 * remote server fetches the Note id it discovered and expects the Note JSON back.
 *
 * Visibility gating: only PUBLIC + PUBLISHED posts owned by the named user are
 * dereferenceable; anything else 404s (never leak drafts/private/other-user
 * posts). Reuses the SAME Note-building path as the outbox (Task 2), unwrapping
 * the Create envelope to return the bare Note with its own `@context`.
 */
router.get('/users/:username/posts/:id', async (req: Request, res: Response) => {
  if (!FEDERATION_ENABLED) return res.status(404).json({ error: 'Federation disabled' });

  const username = getUsername(req);
  const postId = typeof req.params.id === 'string' ? req.params.id : String(req.params.id);

  if (!wantsActivityPub(req)) {
    // A human/browser hit the Note URL — send them to the on-site post.
    return res.redirect(`https://${FEDERATION_DOMAIN}/@${username}/posts/${postId}`);
  }

  // A malformed id can never match a real post — 404 without touching Mongo
  // (an invalid ObjectId would otherwise throw a CastError → 500).
  if (!isValidObjectId(postId)) return res.status(404).json({ error: 'Post not found' });

  try {
    const user = await resolveOxyUser(username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Sharing OFF must be indistinguishable from a nonexistent user — same
    // 404 body, no separate error code. This route was not in the original
    // gate list but serves a user's content the same as the other AP
    // surfaces, so it gets the same treatment.
    if (!isFediverseSharingEnabledFromUser(user)) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userId = user._id || user.id;

    const post = await Post.findOne({
      _id: postId,
      oxyUserId: userId,
      visibility: 'public',
      status: 'published',
    }).lean();
    if (!post) return res.status(404).json({ error: 'Post not found' });

    // When the dereferenced post is a REPLY, carry `inReplyTo` + the parent-author
    // `Mention` so a remote server that pulls this Note by URL threads it. Resolved
    // here (the builder stays pure); fail-soft — a non-reply or unresolvable parent
    // yields null, so the Note is served without `inReplyTo` rather than erroring.
    const replyContext = await activityPubConnector.resolveReplyContext(post);

    // Build via the shared Note path, then unwrap the Create envelope: a
    // dereferenced Note is the `object`, carrying its own top-level `@context`.
    const activity = activityPubConnector.buildCreateNoteActivity(post, username, replyContext ?? undefined);
    const note = activity.object as Record<string, unknown>;

    res.set('Content-Type', AP_CONTENT_TYPE);
    res.set('Cache-Control', 'max-age=300');
    return res.json({ '@context': AP_CONTEXT, ...note });
  } catch (err) {
    logger.error('Post dereference endpoint error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/** Page size for the paginated followers/following collections (mirrors the outbox). */
const FOLLOW_PAGE_SIZE = 20;

/**
 * Serve a user's followers OR following as a paginated ActivityPub
 * `OrderedCollection` — the two surfaces differ only by follow `direction`
 * (`inbound` = followers, `outbound` = following) and the collection URL builder,
 * so they share this one handler.
 *
 * The summary (no `?page=true`) advertises `totalItems` AND a `first` page link,
 * so a remote instance (e.g. mastodon.social) can actually ENUMERATE the members
 * — previously the collection exposed only `totalItems`, so the list rendered
 * empty even when federated edges existed. The paged branch returns an
 * `OrderedCollectionPage` whose `orderedItems` are the remote actor URIs
 * (strings), keyset-paginated by (createdAt, _id) via the SAME ChronoCursor axis
 * the outbox uses, so every member is reachable by walking `next`.
 *
 * Source is `FederatedFollow` (accepted edges in the given direction), the SAME
 * rows the `totalItems` count is derived from — so the count and the enumerated
 * list stay consistent. Keeps the identical fediverse-sharing consent gate +
 * 404-when-off behavior as the sibling AP surfaces.
 */
async function serveFollowCollection(
  req: Request,
  res: Response,
  direction: 'inbound' | 'outbound',
  collectionUrl: (username: string) => string,
): Promise<Response> {
  if (!FEDERATION_ENABLED) return res.status(404).json({ error: 'Federation disabled' });

  const username = getUsername(req);
  const page = req.query.page === 'true';

  try {
    const user = await resolveOxyUser(username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Sharing OFF must be indistinguishable from a nonexistent user — same
    // 404 body, no separate error code.
    if (!isFediverseSharingEnabledFromUser(user)) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userId = String(user._id || user.id);
    const baseMatch = { localUserId: userId, direction, status: 'accepted' as const };

    const count = await FederatedFollow.countDocuments(baseMatch);

    if (!page) {
      res.set('Content-Type', AP_CONTENT_TYPE);
      return res.json({
        '@context': AP_CONTEXT,
        id: collectionUrl(username),
        type: 'OrderedCollection',
        totalItems: count,
        first: `${collectionUrl(username)}?page=true`,
      });
    }

    // Keyset pagination by (createdAt, _id) — overfetch one row to detect a
    // further page without a second count query.
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const pageMatch: Record<string, unknown> = { ...baseMatch };
    ChronoCursor.applyToQuery(pageMatch, cursor);

    const overfetched = await FederatedFollow.find(pageMatch)
      .sort({ createdAt: -1, _id: -1 })
      .limit(FOLLOW_PAGE_SIZE + 1)
      .lean();

    const hasNext = overfetched.length > FOLLOW_PAGE_SIZE;
    const pageRows = hasNext ? overfetched.slice(0, FOLLOW_PAGE_SIZE) : overfetched;

    // A follower/following collection enumerates the REMOTE actor URIs (the AP
    // ids) — bare strings, per the ActivityPub spec's actor collections.
    const orderedItems = pageRows.map((row) => row.remoteActorUri);

    const pageId = cursor
      ? `${collectionUrl(username)}?page=true&cursor=${encodeURIComponent(cursor)}`
      : `${collectionUrl(username)}?page=true`;

    const pageResponse: Record<string, unknown> = {
      '@context': AP_CONTEXT,
      id: pageId,
      type: 'OrderedCollectionPage',
      partOf: collectionUrl(username),
      totalItems: count,
      orderedItems,
    };

    if (hasNext) {
      const lastRow = pageRows[pageRows.length - 1];
      const nextCursor = ChronoCursor.build(String(lastRow._id), lastRow.createdAt);
      pageResponse.next = `${collectionUrl(username)}?page=true&cursor=${encodeURIComponent(nextCursor)}`;
    }

    res.set('Content-Type', AP_CONTENT_TYPE);
    return res.json(pageResponse);
  } catch (err) {
    logger.error('Follow collection endpoint error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /ap/users/:username/followers — Followers collection (inbound accepted edges).
 */
router.get('/users/:username/followers', (req: Request, res: Response) =>
  serveFollowCollection(req, res, 'inbound', followersUrl),
);

/**
 * GET /ap/users/:username/following — Following collection (outbound accepted edges).
 */
router.get('/users/:username/following', (req: Request, res: Response) =>
  serveFollowCollection(req, res, 'outbound', followingUrl),
);

export default router;
