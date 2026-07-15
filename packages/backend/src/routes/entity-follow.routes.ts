import { Router, Response } from 'express';
import { FilterQuery } from 'mongoose';
import { EntityFollow, ENTITY_FOLLOW_TYPES, type EntityFollowType, type IEntityFollow } from '../models/EntityFollow';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { logger } from '../utils/logger';
import { listSubscriptionService, LIST_ENTITY_TYPE } from '../services/ListSubscriptionService';
import { queryInt, queryString } from '../utils/queryParams';

const router = Router();

const DEFAULT_FOLLOW_PAGE_SIZE = 20;
const MAX_FOLLOW_PAGE_SIZE = 50;

function isValidEntityType(type: string): type is EntityFollowType {
  return (ENTITY_FOLLOW_TYPES as readonly string[]).includes(type);
}

const clampFollowPageSize = (limit: number | undefined): number =>
  Math.min(Math.max(limit || DEFAULT_FOLLOW_PAGE_SIZE, 1), MAX_FOLLOW_PAGE_SIZE);

/**
 * Follow an entity
 * POST /entity-follows
 */
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { entityType, entityId } = req.body;

    if (!entityType || !entityId) {
      return res.status(400).json({ message: 'entityType and entityId are required' });
    }

    if (!isValidEntityType(entityType)) {
      return res.status(400).json({ message: `entityType must be one of: ${ENTITY_FOLLOW_TYPES.join(', ')}` });
    }

    const follow = new EntityFollow({ userId, entityType, entityId });
    await follow.save();

    // Following a list is a subscription: bump the list's subscriber count.
    // This does NOT follow the list's members and does NOT affect follower counts.
    if (entityType === LIST_ENTITY_TYPE) {
      await listSubscriptionService.incrementSubscriberCount(entityId);
    }

    logger.debug(`User ${userId} followed ${entityType}:${entityId}`);

    res.status(201).json({ follow });
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 11000) {
      return res.status(409).json({ message: 'Already following this entity' });
    }
    logger.error('Error creating entity follow:', { userId: req.user?.id, error });
    res.status(500).json({
      message: 'Error creating entity follow',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Unfollow an entity
 * DELETE /entity-follows
 */
router.delete('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { entityType, entityId } = req.body;

    if (!entityType || !entityId) {
      return res.status(400).json({ message: 'entityType and entityId are required' });
    }

    if (!isValidEntityType(entityType)) {
      return res.status(400).json({ message: `entityType must be one of: ${ENTITY_FOLLOW_TYPES.join(', ')}` });
    }

    const result = await EntityFollow.findOneAndDelete({ userId, entityType, entityId });

    if (!result) {
      return res.status(404).json({ message: 'Entity follow not found' });
    }

    // Unsubscribing from a list decrements its subscriber count (floored at 0).
    if (entityType === LIST_ENTITY_TYPE) {
      await listSubscriptionService.decrementSubscriberCount(entityId);
    }

    logger.debug(`User ${userId} unfollowed ${entityType}:${entityId}`);

    res.json({ message: 'Entity unfollowed successfully' });
  } catch (error) {
    logger.error('Error deleting entity follow:', { userId: req.user?.id, error });
    res.status(500).json({
      message: 'Error deleting entity follow',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Check follow status
 * GET /entity-follows/status?entityType=...&entityId=...
 */
router.get('/status', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Both are Mongo query values below, so they must be real strings — an
    // `?entityId[$ne]=x` object would otherwise reach `findOne` as an operator.
    const entityType = queryString(req.query.entityType);
    const entityId = queryString(req.query.entityId);

    if (!entityType || !entityId) {
      return res.status(400).json({ message: 'entityType and entityId query params are required' });
    }

    if (!isValidEntityType(entityType)) {
      return res.status(400).json({ message: `entityType must be one of: ${ENTITY_FOLLOW_TYPES.join(', ')}` });
    }

    const follow = await EntityFollow.findOne({ userId, entityType, entityId });

    res.json({ isFollowing: !!follow });
  } catch (error) {
    logger.error('Error checking entity follow status:', { userId: req.user?.id, error });
    res.status(500).json({
      message: 'Error checking entity follow status',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * List current user's entity follows
 * GET /entity-follows?type=...&limit=...&cursor=...
 */
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const type = queryString(req.query.type);
    const limit = clampFollowPageSize(queryInt(req.query.limit));
    const cursor = queryString(req.query.cursor);

    if (type && !isValidEntityType(type)) {
      return res.status(400).json({ message: `type must be one of: ${ENTITY_FOLLOW_TYPES.join(', ')}` });
    }

    const query: FilterQuery<IEntityFollow> = { userId };
    if (type) {
      query.entityType = type;
    }
    if (cursor) {
      query._id = { $lt: cursor };
    }

    const follows = await EntityFollow.find(query)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = follows.length > limit;
    const results = hasMore ? follows.slice(0, limit) : follows;
    const nextCursor = hasMore && results.length > 0 ? String(results[results.length - 1]._id) : undefined;

    res.json({ follows: results, hasMore, nextCursor });
  } catch (error) {
    logger.error('Error listing entity follows:', { userId: req.user?.id, error });
    res.status(500).json({
      message: 'Error listing entity follows',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * List followers of an entity
 * GET /entity-follows/:entityType/:entityId/followers?limit=...&cursor=...
 */
router.get('/:entityType/:entityId/followers', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const entityType = req.params.entityType as string;
    const entityId = req.params.entityId as string;

    if (!isValidEntityType(entityType)) {
      return res.status(400).json({ message: `entityType must be one of: ${ENTITY_FOLLOW_TYPES.join(', ')}` });
    }

    const limit = clampFollowPageSize(queryInt(req.query.limit));
    const cursor = queryString(req.query.cursor);

    const query: FilterQuery<IEntityFollow> = { entityType, entityId };
    if (cursor) {
      query._id = { $lt: cursor };
    }

    const followers = await EntityFollow.find(query)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = followers.length > limit;
    const results = hasMore ? followers.slice(0, limit) : followers;
    const nextCursor = hasMore && results.length > 0 ? String(results[results.length - 1]._id) : undefined;

    res.json({ followers: results, hasMore, nextCursor });
  } catch (error) {
    logger.error('Error listing entity followers:', { entityType: req.params.entityType, entityId: req.params.entityId, error });
    res.status(500).json({
      message: 'Error listing entity followers',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
