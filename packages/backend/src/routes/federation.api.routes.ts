import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthRequest } from '../types/auth';
import { logger } from '../utils/logger';
import { federationService } from '../services/FederationService';
import FederatedActor, { IFederatedActor } from '../models/FederatedActor';
import FederatedFollow from '../models/FederatedFollow';
import { Post } from '../models/Post';
import { FEDERATION_ENABLED } from '../utils/federation/constants';
import { postHydrationService } from '../services/PostHydrationService';
import { createScopedOxyClient } from '../utils/oxyHelpers';
import { apiRateLimiter } from '../middleware/rateLimiter';

const router = Router();

// Rate-limit all federation API routes (200 req/min per user or IP)
router.use(apiRateLimiter);

// --- Zod schemas ---

const actorUriSchema = z.object({
  actorUri: z.string().url('Invalid actorUri'),
});

const actorPostsQuerySchema = z.object({
  uri: z.string().url('Invalid uri parameter'),
  cursor: z.string().datetime({ offset: true }).optional(),
});

// --- Helpers ---

/** Guard: return 404 if federation is disabled. */
function requireFederation(res: Response): boolean {
  if (!FEDERATION_ENABLED) {
    res.status(404).json({ error: 'Federation disabled' });
    return false;
  }
  return true;
}

/** Guard: return 401 if no authenticated user. Returns userId or null. */
function requireAuth(req: AuthRequest, res: Response): string | null {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return userId;
}

// --- Routes ---
// Note: Profile search/lookup is handled by OxyHQServices (/profiles/search, /profiles/resolve).
// These routes handle Mention-specific federation operations (follows, posts).

/**
 * POST /federation/follow
 * Follow a remote fediverse actor.
 */
router.post('/follow', async (req: AuthRequest, res: Response) => {
  if (!requireFederation(res)) return;
  const userId = requireAuth(req, res);
  if (!userId) return;

  const parsed = actorUriSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  try {
    const { oxy } = require('../../server.js');
    const user = await oxy.getUserById(userId);
    if (!user?.username) return res.status(404).json({ error: 'User not found' });

    const result = await federationService.sendFollow(userId, user.username, parsed.data.actorUri);
    return res.json({
      success: result.success,
      pending: result.pending,
      actorUri: parsed.data.actorUri,
    });
  } catch (err) {
    logger.error('Federation follow error:', err);
    return res.status(500).json({ error: 'Follow failed' });
  }
});

/**
 * POST /federation/unfollow
 * Unfollow a remote fediverse actor.
 */
router.post('/unfollow', async (req: AuthRequest, res: Response) => {
  if (!requireFederation(res)) return;
  const userId = requireAuth(req, res);
  if (!userId) return;

  const parsed = actorUriSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  try {
    const { oxy } = require('../../server.js');
    const user = await oxy.getUserById(userId);
    if (!user?.username) return res.status(404).json({ error: 'User not found' });

    const success = await federationService.sendUndoFollow(userId, user.username, parsed.data.actorUri);
    return res.json({ success, actorUri: parsed.data.actorUri });
  } catch (err) {
    logger.error('Federation unfollow error:', err);
    return res.status(500).json({ error: 'Unfollow failed' });
  }
});

/**
 * GET /federation/following
 * List remote accounts the current user follows.
 */
router.get('/following', async (req: AuthRequest, res: Response) => {
  if (!requireFederation(res)) return;
  const userId = requireAuth(req, res);
  if (!userId) return;

  try {
    const follows = await FederatedFollow.find({
      localUserId: userId,
      direction: 'outbound',
      status: { $in: ['accepted', 'pending'] },
    }).lean();

    const actorUris = follows.map((f) => f.remoteActorUri);
    const actors = await FederatedActor.find({ uri: { $in: actorUris } }).lean();
    const actorMap = new Map(actors.map((a) => [a.uri, a]));

    const results = follows.map((f) => {
      const actor = actorMap.get(f.remoteActorUri);
      return {
        actorUri: f.remoteActorUri,
        handle: actor?.username || 'unknown',
        instance: actor?.domain || 'unknown',
        fullHandle: actor ? `@${actor.acct}` : f.remoteActorUri,
        displayName: actor?.displayName || actor?.username || 'Unknown',
        avatarUrl: actor?.avatarUrl,
        isFollowing: f.status === 'accepted',
        isFollowPending: f.status === 'pending',
      };
    });

    return res.json({ following: results });
  } catch (err) {
    logger.error('Federation following list error:', err);
    return res.status(500).json({ error: 'Failed to fetch following' });
  }
});

/**
 * GET /federation/followers
 * List remote accounts following the current user.
 */
router.get('/followers', async (req: AuthRequest, res: Response) => {
  if (!requireFederation(res)) return;
  const userId = requireAuth(req, res);
  if (!userId) return;

  try {
    const follows = await FederatedFollow.find({
      localUserId: userId,
      direction: 'inbound',
      status: 'accepted',
    }).lean();

    const actorUris = follows.map((f) => f.remoteActorUri);
    const actors = await FederatedActor.find({ uri: { $in: actorUris } }).lean();
    const actorMap = new Map(actors.map((a) => [a.uri, a]));

    const results = follows.map((f) => {
      const actor = actorMap.get(f.remoteActorUri);
      return {
        actorUri: f.remoteActorUri,
        handle: actor?.username || 'unknown',
        instance: actor?.domain || 'unknown',
        fullHandle: actor ? `@${actor.acct}` : f.remoteActorUri,
        displayName: actor?.displayName || actor?.username || 'Unknown',
        avatarUrl: actor?.avatarUrl,
      };
    });

    return res.json({ followers: results });
  } catch (err) {
    logger.error('Federation followers list error:', err);
    return res.status(500).json({ error: 'Failed to fetch followers' });
  }
});

/**
 * GET /federation/actor/posts?uri=...&cursor=...
 * Get posts from a federated actor stored locally.
 */
router.get('/actor/posts', async (req: AuthRequest, res: Response) => {
  if (!requireFederation(res)) return;

  const parsed = actorPostsQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  try {
    const actor = await FederatedActor.findOne({ uri: parsed.data.uri }).lean();
    if (!actor) return res.json({ posts: [], hasMore: false });

    const limit = 20;
    // AP activity IDs are namespaced under the actor URI (e.g. https://instance/users/alice/statuses/123)
    // Use a range query so the B-tree index on federation.activityId is used (regex can't use it)
    const query: Record<string, unknown> = {
      'federation.activityId': { $gte: actor.uri + '/', $lt: actor.uri + '/\uffff' },
    };
    if (parsed.data.cursor) {
      query.createdAt = { $lt: new Date(parsed.data.cursor) };
    }

    let posts = await Post.find(query)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean();

    // If no local posts and no cursor (first page), trigger async sync
    if (posts.length === 0 && !parsed.data.cursor && actor.outboxUrl) {
      // Fire-and-forget: sync in background, return syncing flag to client
      federationService.syncOutboxPosts(actor as unknown as IFederatedActor, limit).catch((err) => {
        logger.warn('Background outbox sync failed:', err);
      });
      return res.json({ posts: [], hasMore: false, syncing: true });
    }

    const hasMore = posts.length > limit;
    const sliced = hasMore ? posts.slice(0, limit) : posts;
    const nextCursor = hasMore ? sliced[sliced.length - 1].createdAt : undefined;

    // Hydrate posts so they render identically to native posts
    const hydrated = await postHydrationService.hydratePosts(sliced, {
      viewerId: req.user?.id,
      oxyClient: createScopedOxyClient(req),
      maxDepth: 0,
      includeLinkMetadata: false,
    });

    return res.json({ posts: hydrated, hasMore, nextCursor, syncing: false });
  } catch (err) {
    logger.error('Federation actor posts error:', err);
    return res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

export default router;
