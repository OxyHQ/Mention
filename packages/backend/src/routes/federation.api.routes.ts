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

const searchSchema = z.object({
  q: z.string().min(1, 'Missing query parameter q').trim(),
});

const lookupSchema = z.object({
  handle: z.string().min(1, 'Missing handle parameter').trim(),
});

const actorUriSchema = z.object({
  actorUri: z.string().url('Invalid actorUri'),
});

const actorQuerySchema = z.object({
  uri: z.string().url('Invalid uri parameter'),
});

const actorPostsQuerySchema = z.object({
  uri: z.string().url('Invalid uri parameter'),
  cursor: z.string().datetime({ offset: true }).optional(),
});

// --- Helpers ---

/** Map a FederatedActor document to the API response shape. */
function toActorResponse(
  actor: IFederatedActor,
  followState?: { isFollowing: boolean; isFollowPending: boolean },
) {
  return {
    id: String(actor._id),
    actorUri: actor.uri,
    handle: actor.username,
    instance: actor.domain,
    fullHandle: `@${actor.acct}`,
    displayName: actor.displayName || actor.username,
    avatarUrl: actor.avatarUrl,
    bannerUrl: actor.headerUrl,
    bio: actor.summary,
    fields: actor.fields?.map((f: any) => ({
      name: f.name,
      value: f.value,
      verifiedAt: f.verifiedAt?.toISOString?.() || f.verifiedAt,
    })),
    followersCount: actor.followersCount,
    followingCount: actor.followingCount,
    postsCount: actor.postsCount,
    isFollowing: followState?.isFollowing ?? false,
    isFollowPending: followState?.isFollowPending ?? false,
    discoverable: actor.discoverable,
    memorial: actor.memorial,
    suspended: actor.suspended,
    createdAt: actor.remoteCreatedAt?.toISOString?.() || actor.remoteCreatedAt,
    type: actor.type,
  };
}

/** Check the current user's follow status for a remote actor. */
async function getFollowState(userId: string | undefined, actorUri: string) {
  if (!userId) return { isFollowing: false, isFollowPending: false };

  const follow = await FederatedFollow.findOne({
    localUserId: userId,
    remoteActorUri: actorUri,
    direction: 'outbound',
  }).lean();

  return {
    isFollowing: follow?.status === 'accepted',
    isFollowPending: follow?.status === 'pending',
  };
}

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

/**
 * GET /federation/search?q=user@domain
 * Search/resolve a fediverse user by WebFinger handle.
 */
router.get('/search', async (req: AuthRequest, res: Response) => {
  if (!requireFederation(res)) return;

  const parsed = searchSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  try {
    const actor = await federationService.lookupActor(parsed.data.q);
    if (!actor) return res.json({ actors: [], query: parsed.data.q });

    const followState = await getFollowState(req.user?.id, actor.uri);
    return res.json({
      actors: [toActorResponse(actor, followState)],
      query: parsed.data.q,
    });
  } catch (err) {
    logger.error('Federation search error:', err);
    return res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * GET /federation/lookup?handle=@user@instance
 * Resolve a single fediverse handle.
 */
router.get('/lookup', async (req: AuthRequest, res: Response) => {
  if (!requireFederation(res)) return;

  const parsed = lookupSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  try {
    const actor = await federationService.lookupActor(parsed.data.handle);
    if (!actor) return res.json({ actor: null });

    const followState = await getFollowState(req.user?.id, actor.uri);
    return res.json({ actor: toActorResponse(actor, followState) });
  } catch (err) {
    logger.error('Federation lookup error:', err);
    return res.status(500).json({ error: 'Lookup failed' });
  }
});

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
 * GET /federation/actor?uri=...
 * Get a stored remote actor's profile.
 */
router.get('/actor', async (req: AuthRequest, res: Response) => {
  if (!requireFederation(res)) return;

  const parsed = actorQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  try {
    const actor = await federationService.getOrFetchActor(parsed.data.uri);
    if (!actor) return res.json({ actor: null });

    const followState = await getFollowState(req.user?.id, actor.uri);
    return res.json({ actor: toActorResponse(actor, followState) });
  } catch (err) {
    logger.error('Federation actor error:', err);
    return res.status(500).json({ error: 'Failed to fetch actor' });
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
    const query: Record<string, unknown> = { federatedActorId: actor._id };
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
