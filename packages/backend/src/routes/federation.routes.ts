import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger';
import { federationService } from '../services/FederationService';
import { verifyHttpSignature, getOrCreateKeyPair } from '../utils/federation/crypto';
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

const router = Router();

// Rate-limit AP protocol endpoints (30 req/min per IP — prevent abuse as DDoS vector)
const apRateLimiter = rateLimit({
  store: new RedisStore({ prefix: 'rate-limit:ap:', windowMs: 60 * 1000 }),
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too Many Requests' },
  keyGenerator: (req) => req.ip || req.socket.remoteAddress || 'unknown',
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
    const user = await resolveOxyUser(username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const userId = user._id || user.id;
    const keyPair = await getOrCreateKeyPair(userId, username);

    const actorObject = {
      '@context': AP_CONTEXT,
      id: actorUrl(username),
      type: 'Person',
      preferredUsername: username,
      name: user.name?.full || user.displayName || username,
      summary: user.bio || '',
      url: `https://${FEDERATION_DOMAIN}/@${username}`,
      inbox: inboxUrl(username),
      outbox: outboxUrl(username),
      followers: followersUrl(username),
      following: followingUrl(username),
      endpoints: { sharedInbox: sharedInboxUrl() },
      icon: user.avatar ? {
        type: 'Image',
        mediaType: 'image/png',
        url: user.avatar,
      } : undefined,
      publicKey: {
        id: keyPair.keyId,
        owner: actorUrl(username),
        publicKeyPem: keyPair.publicKeyPem,
      },
    };

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
    // Verify HTTP signature
    const { verified, actorUri } = await verifyHttpSignature(
      {
        method: req.method,
        path: req.path,
        headers: req.headers as Record<string, string | string[] | undefined>,
        body: req.body,
      },
      (keyId) => federationService.fetchPublicKey(keyId),
    );

    if (!verified || !actorUri) {
      logger.debug('Inbox: HTTP signature verification failed');
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

    // Process asynchronously — return 202 Accepted immediately
    federationService.processInboxActivity(activity, actorUri).catch((err) => {
      logger.error('Error processing inbox activity:', err);
    });

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
    // Count inbound follows for this user
    const count = await FederatedFollow.countDocuments({
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
    const count = await FederatedFollow.countDocuments({
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
