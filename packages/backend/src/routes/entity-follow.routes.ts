import { Router, Response } from 'express';
import { EntityFollow } from '../models/EntityFollow';
import { CustomFeed } from '../models/CustomFeed';
import { AccountList } from '../models/AccountList';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { logger } from '../utils/logger';
import { listSubscriptionService, LIST_ENTITY_TYPE } from '../services/ListSubscriptionService';

const router = Router();

const VALID_ENTITY_TYPES = ['hashtag', 'feed', 'list', 'topic'] as const;
type EntityType = (typeof VALID_ENTITY_TYPES)[number];
type AccessError = { status: number; message: string };

function isValidEntityType(type: string): type is (typeof VALID_ENTITY_TYPES)[number] {
  return (VALID_ENTITY_TYPES as readonly string[]).includes(type);
}

async function assertEntityFollowAccess(
  entityType: EntityType,
  entityId: string,
  userId: string,
): Promise<AccessError | null> {
  if (entityType === 'feed') {
    const feed = await CustomFeed.findById(entityId).select('isPublic ownerOxyUserId').lean();
    if (!feed) {
      return { status: 404, message: 'Feed not found' };
    }
    if (!feed.isPublic && feed.ownerOxyUserId !== userId) {
      return { status: 403, message: 'Not allowed' };
    }
  }

  if (entityType === LIST_ENTITY_TYPE) {
    const list = await AccountList.findById(entityId).select('isPublic ownerOxyUserId').lean();
    if (!list) {
      return { status: 404, message: 'List not found' };
    }
    if (!list.isPublic && list.ownerOxyUserId !== userId) {
      return { status: 403, message: 'Not allowed' };
    }
  }

  return null;
}

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
      return res.status(400).json({ message: `entityType must be one of: ${VALID_ENTITY_TYPES.join(', ')}` });
    }

    const accessError = await assertEntityFollowAccess(entityType, entityId, userId);
    if (accessError) {
      return res.status(accessError.status).json({ message: accessError.message });
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
  } catch (error: any) {
    if (error?.code === 11000) {
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
      return res.status(400).json({ message: `entityType must be one of: ${VALID_ENTITY_TYPES.join(', ')}` });
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

    const entityType = req.query.entityType as string;
    const entityId = req.query.entityId as string;

    if (!entityType || !entityId) {
      return res.status(400).json({ message: 'entityType and entityId query params are required' });
    }

    if (!isValidEntityType(entityType)) {
      return res.status(400).json({ message: `entityType must be one of: ${VALID_ENTITY_TYPES.join(', ')}` });
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

    const type = req.query.type as string | undefined;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || 20), 10), 1), 50);
    const cursor = req.query.cursor as string | undefined;

    if (type && !isValidEntityType(type)) {
      return res.status(400).json({ message: `type must be one of: ${VALID_ENTITY_TYPES.join(', ')}` });
    }

    const query: any = { userId };
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
      return res.status(400).json({ message: `entityType must be one of: ${VALID_ENTITY_TYPES.join(', ')}` });
    }

    const accessError = await assertEntityFollowAccess(entityType, entityId, userId);
    if (accessError) {
      return res.status(accessError.status).json({ message: accessError.message });
    }

    const limit = Math.min(Math.max(parseInt(String(req.query.limit || 20), 10), 1), 50);
    const cursor = req.query.cursor as string | undefined;

    const query: any = { entityType, entityId };
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
