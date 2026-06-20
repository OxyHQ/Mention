import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger';
import { federationService } from '../services/FederationService';
import { verifyHttpSignature, getPublicKey } from '../utils/federation/crypto';
import { Post } from '../models/Post';
import FederatedFollow from '../models/FederatedFollow';
import {
  FEDERATION_DOMAIN,
  FEDERATION_ENABLED,
  AP_CONTEXT,
  AP_CONTENT_TYPE,
  AP_ACCEPT_TYPES,
  actorUrl,
  inboxUrl,
  outboxUrl,
  followersUrl,
  followingUrl,
  sharedInboxUrl,
  resolveOxyUser,
} from '../utils/federation/constants';
import rateLimit from 'express-rate-limit';
import { RedisStore } from '../middleware/rateLimitStore';
import { enqueueInboxActivity } from '../queue/producers';
import { resolveAvatarUrl } from '../utils/mediaResolver';

const router = Router();

// Rate-limit AP protocol endpoints (30 req/min per IP — prevent abuse as DDoS vector)
const apRateLimiter = rateLimit({
  store: new RedisStore({ prefix: 'rate-limit:ap:', windowMs: 60 * 1000 }),
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too Many Requests' },
  // Default keyGenerator uses req.ip, which is what we want
});
router.use(apRateLimiter);

/**
 * Content negotiation: check if request wants ActivityPub JSON-LD.
 */
function wantsActivityPub(req: Request): boolean {
  const accept = req.headers.accept || '';
  return AP_ACCEPT_TYPES.some((type) => accept.includes(type));
}

/** Extract username param safely as a string. */
function getUsername(req: Request): string {
  const val = req.params.username;
  return typeof val === 'string' ? val : Array.isArray(val) ? val[0] : String(val);
}

/** Fields of the resolved Oxy user the actor document reads. */
interface ActorUserView {
  name?: { displayName?: string | null } | null;
  bio?: string | null;
  avatar?: string | null;
  createdAt?: string | null;
}

/** Map common image extensions to a MIME type for the actor `icon.mediaType`. */
const ICON_MEDIA_TYPE_BY_EXT: Record<string, string> = {
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

  let extension: string | undefined;
  try {
    const pathname = new URL(resolved).pathname;
    extension = pathname.split('.').pop()?.toLowerCase();
  } catch {
    extension = resolved.split('?')[0]?.split('.').pop()?.toLowerCase();
  }
  const mediaType = extension ? ICON_MEDIA_TYPE_BY_EXT[extension] : undefined;
  return mediaType ? { type: 'Image', url: resolved, mediaType } : { type: 'Image', url: resolved };
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

    const publicKey = await getPublicKey(username);

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
      followers: followersUrl(username),
      following: followingUrl(username),
      endpoints: { sharedInbox: sharedInboxUrl() },
      discoverable: true,
      manuallyApprovesFollowers: false,
      icon: buildActorIcon(user.avatar),
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
      (keyId) => federationService.fetchPublicKey(keyId),
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
      federationService.processInboxActivity(activity, actorUri).catch((err) => {
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

    // Return paginated items
    const limit = 20;
    const posts = await Post.find({
      oxyUserId: userId,
      visibility: 'public',
      status: 'published',
      parentPostId: null,
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const items = posts.map((post) => {
      const noteId = `${actorUrl(username)}/posts/${post._id}`;
      return {
        id: `${noteId}/activity`,
        type: 'Create',
        actor: actorUrl(username),
        published: post.createdAt,
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        cc: [`${actorUrl(username)}/followers`],
        object: {
          id: noteId,
          type: 'Note',
          attributedTo: actorUrl(username),
          content: post.content?.text || '',
          published: post.createdAt,
          to: ['https://www.w3.org/ns/activitystreams#Public'],
          cc: [`${actorUrl(username)}/followers`],
        },
      };
    });

    res.set('Content-Type', AP_CONTENT_TYPE);
    return res.json({
      '@context': AP_CONTEXT,
      id: `${outboxUrl(username)}?page=true`,
      type: 'OrderedCollectionPage',
      partOf: outboxUrl(username),
      totalItems: totalPosts,
      orderedItems: items,
    });
  } catch (err) {
    logger.error('Outbox endpoint error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /ap/users/:username/followers — Followers collection
 */
router.get('/users/:username/followers', async (req: Request, res: Response) => {
  if (!FEDERATION_ENABLED) return res.status(404).json({ error: 'Federation disabled' });

  const username = getUsername(req);

  try {
    const user = await resolveOxyUser(username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const userId = String(user._id || user.id);

    const count = await FederatedFollow.countDocuments({
      localUserId: userId,
      direction: 'inbound',
      status: 'accepted',
    });

    res.set('Content-Type', AP_CONTENT_TYPE);
    return res.json({
      '@context': AP_CONTEXT,
      id: followersUrl(username),
      type: 'OrderedCollection',
      totalItems: count,
    });
  } catch (err) {
    logger.error('Followers endpoint error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /ap/users/:username/following — Following collection
 */
router.get('/users/:username/following', async (req: Request, res: Response) => {
  if (!FEDERATION_ENABLED) return res.status(404).json({ error: 'Federation disabled' });

  const username = getUsername(req);

  try {
    const user = await resolveOxyUser(username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const userId = String(user._id || user.id);

    const count = await FederatedFollow.countDocuments({
      localUserId: userId,
      direction: 'outbound',
      status: 'accepted',
    });

    res.set('Content-Type', AP_CONTENT_TYPE);
    return res.json({
      '@context': AP_CONTEXT,
      id: followingUrl(username),
      type: 'OrderedCollection',
      totalItems: count,
    });
  } catch (err) {
    logger.error('Following endpoint error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
