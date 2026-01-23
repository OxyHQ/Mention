import { Router, Response } from 'express';
import { AuthRequest } from '../types/auth';
import { logger } from '../utils/logger';

const router = Router();

/**
 * Emit a follow event via socket
 * This route is called after a successful follow action in the Oxy service
 * to broadcast real-time updates to connected clients
 */
router.post('/emit-follow', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { followingId, followerCount, followingCount } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!followingId) {
      return res.status(400).json({ message: 'followingId is required' });
    }

    // Emit socket event
    const io = (global as any).io;
    if (io) {
      io.emit('user:followed', {
        followerId: userId,
        followingId,
        followerCount,
        followingCount,
        timestamp: new Date().toISOString(),
      });

      // Also emit to specific user rooms for targeted updates
      io.to(`user:${followingId}`).emit('user:followed', {
        followerId: userId,
        followingId,
        followerCount,
        followingCount,
        timestamp: new Date().toISOString(),
      });

      logger.debug(`Emitted user:followed event - ${userId} followed ${followingId}`);
    }

    return res.json({ success: true });
  } catch (error) {
    logger.error('Error emitting follow event:', error);
    return res.status(500).json({ message: 'Error emitting follow event' });
  }
});

/**
 * Emit an unfollow event via socket
 * This route is called after a successful unfollow action in the Oxy service
 */
router.post('/emit-unfollow', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { followingId, followerCount, followingCount } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!followingId) {
      return res.status(400).json({ message: 'followingId is required' });
    }

    // Emit socket event
    const io = (global as any).io;
    if (io) {
      io.emit('user:unfollowed', {
        followerId: userId,
        followingId,
        followerCount,
        followingCount,
        timestamp: new Date().toISOString(),
      });

      // Also emit to specific user rooms for targeted updates
      io.to(`user:${followingId}`).emit('user:unfollowed', {
        followerId: userId,
        followingId,
        followerCount,
        followingCount,
        timestamp: new Date().toISOString(),
      });

      logger.debug(`Emitted user:unfollowed event - ${userId} unfollowed ${followingId}`);
    }

    return res.json({ success: true });
  } catch (error) {
    logger.error('Error emitting unfollow event:', error);
    return res.status(500).json({ message: 'Error emitting unfollow event' });
  }
});

export default router;
