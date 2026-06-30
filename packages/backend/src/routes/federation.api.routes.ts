import { Router, Response } from 'express';
import { z } from 'zod';
import { getRequiredOxyUserId, type OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import type { User as OxyUser } from '@oxyhq/core';
import { PostVisibility } from '@mention/shared-types';
import { logger } from '../utils/logger';
import { activityPubConnector, isPermanentlyUnavailableOutboxReason } from '../connectors/activitypub/ActivityPubConnector';
import FederatedActor from '../models/FederatedActor';
import FederatedFollow from '../models/FederatedFollow';
import { Post } from '../models/Post';
import { FEDERATION_ENABLED } from '../connectors/activitypub/constants';
import { postHydrationService } from '../services/PostHydrationService';
import { createScopedOxyClient, getServiceOxyClient } from '../utils/oxyHelpers';
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

/**
 * Resolve the authenticated Oxy user id, or write a 401 and return null.
 *
 * Identity resolution is owned entirely by `@oxyhq/core/server`
 * (`getRequiredOxyUserId`, which throws when unauthenticated). This wrapper only
 * translates that into an HTTP 401 — these routes are mounted under `optionalAuth`,
 * so the federation availability check (404) must run before this auth check.
 */
function resolveUserOr401(req: AuthRequest, res: Response): string | null {
  try {
    return getRequiredOxyUserId(req);
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
}

function hasUnavailableCurrentOutbox(actor: { outboxUrl?: string; outboxBackfill?: { outboxUrl?: string; status?: string } }): boolean {
  return Boolean(
    actor.outboxUrl
    && actor.outboxBackfill?.outboxUrl === actor.outboxUrl
    && actor.outboxBackfill.status === 'unavailable',
  );
}

/**
 * Resolve the canonical Oxy `name.displayName` for a batch of federated actors,
 * keyed by actor URI.
 *
 * Display names are owned by the Oxy API (`name.displayName`) and are the SINGLE
 * source of truth — Mention never reads a local `FederatedActor` name copy.
 * Actors are batch-resolved by their `oxyUserId` through the service client
 * (mirrors `PostHydrationService.resolveUserSummaries`). An actor whose Oxy user
 * is missing from the response is omitted, so the caller falls back to the
 * actor's `@<acct>` handle.
 */
async function resolveActorDisplayNamesByUri(
  actors: Array<{ uri: string; oxyUserId?: string }>,
): Promise<Map<string, string>> {
  const byUri = new Map<string, string>();
  const oxyUserIds = Array.from(
    new Set(actors.map((a) => a.oxyUserId).filter((id): id is string => Boolean(id))),
  );
  if (oxyUserIds.length === 0) return byUri;

  let users: OxyUser[] = [];
  try {
    users = await getServiceOxyClient().getUsersByIds(oxyUserIds);
  } catch (err) {
    logger.warn('Failed to resolve Oxy display names for federated actors:', err);
    return byUri;
  }

  const nameByOxyId = new Map<string, string>();
  for (const user of users) {
    const id = String((user as { id?: unknown }).id ?? '');
    const displayName = user.name.displayName;
    if (id && displayName) nameByOxyId.set(id, displayName);
  }

  for (const actor of actors) {
    if (!actor.oxyUserId) continue;
    const displayName = nameByOxyId.get(actor.oxyUserId);
    if (displayName) byUri.set(actor.uri, displayName);
  }
  return byUri;
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
  const userId = resolveUserOr401(req, res);
  if (!userId) return;

  const parsed = actorUriSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  try {
    const { oxy } = require('../../server.js');
    const user = await oxy.getUserById(userId);
    if (!user?.username) return res.status(404).json({ error: 'User not found' });

    const result = await activityPubConnector.sendFollow(userId, user.username, parsed.data.actorUri);
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
  const userId = resolveUserOr401(req, res);
  if (!userId) return;

  const parsed = actorUriSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  try {
    const { oxy } = require('../../server.js');
    const user = await oxy.getUserById(userId);
    if (!user?.username) return res.status(404).json({ error: 'User not found' });

    const success = await activityPubConnector.sendUndoFollow(userId, user.username, parsed.data.actorUri);
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
  const userId = resolveUserOr401(req, res);
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
    const displayNameByUri = await resolveActorDisplayNamesByUri(actors);

    const results = follows.map((f) => {
      const actor = actorMap.get(f.remoteActorUri);
      const handleFallback = actor ? `@${actor.acct}` : f.remoteActorUri;
      return {
        actorUri: f.remoteActorUri,
        handle: actor?.username || 'unknown',
        instance: actor?.domain || 'unknown',
        fullHandle: handleFallback,
        displayName: (actor && displayNameByUri.get(actor.uri)) || handleFallback,
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
  const userId = resolveUserOr401(req, res);
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
    const displayNameByUri = await resolveActorDisplayNamesByUri(actors);

    const results = follows.map((f) => {
      const actor = actorMap.get(f.remoteActorUri);
      const handleFallback = actor ? `@${actor.acct}` : f.remoteActorUri;
      return {
        actorUri: f.remoteActorUri,
        handle: actor?.username || 'unknown',
        instance: actor?.domain || 'unknown',
        fullHandle: handleFallback,
        displayName: (actor && displayNameByUri.get(actor.uri)) || handleFallback,
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
    // Query by oxyUserId (the canonical user identity in Oxy) for federated posts.
    // Falls back to the activity ID range query if the actor has no Oxy link yet.
    const query: Record<string, unknown> = actor.oxyUserId
      ? { oxyUserId: actor.oxyUserId, federation: { $ne: null }, visibility: PostVisibility.PUBLIC }
      : {
          'federation.activityId': { $gte: actor.uri + '/', $lt: actor.uri + '/\uffff' },
          visibility: PostVisibility.PUBLIC,
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
      if (hasUnavailableCurrentOutbox(actor)) {
        return res.json({ posts: [], hasMore: false, syncing: false, syncUnavailable: true });
      }

      // Fire-and-forget: sync in background, return syncing flag to client
      activityPubConnector.syncOutboxPostsDetailed(actor, limit)
        .then(async (result) => {
          if (isPermanentlyUnavailableOutboxReason(result.reason)) {
            await activityPubConnector.markOutboxBackfillUnavailable(actor, result.reason);
          }
        })
        .catch((err) => {
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
      maxDepth: 1,
      publicReferencesOnly: true,
      includeLinkMetadata: false,
    });

    return res.json({ posts: hydrated, hasMore, nextCursor, syncing: false });
  } catch (err) {
    logger.error('Federation actor posts error:', err);
    return res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

export default router;
