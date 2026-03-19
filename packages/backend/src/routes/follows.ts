import { Router, Response } from 'express';
import { AuthRequest } from '../types/auth';
import { logger } from '../utils/logger';
import { getIO } from '../utils/socketRegistry';

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

    // Emit socket event to specific user rooms only (no global broadcast)
    const io = getIO();
    if (io) {
      const eventData = {
        followerId: userId,
        followingId,
        followerCount,
        followingCount,
        timestamp: new Date().toISOString(),
      };

      // Emit to both the follower and the followed user's rooms
      io.to(`user:${followingId}`).emit('user:followed', eventData);
      io.to(`user:${userId}`).emit('user:followed', eventData);

      logger.debug(`Emitted user:followed event - ${userId} followed ${followingId}`);
    }

    return res.json({ success: true });
  } catch (error) {
    logger.error('Error emitting follow event:', { userId: req.user?.id, followingId: req.body.followingId, error });
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

    // Emit socket event to specific user rooms only (no global broadcast)
    const io = getIO();
    if (io) {
      const eventData = {
        followerId: userId,
        followingId,
        followerCount,
        followingCount,
        timestamp: new Date().toISOString(),
      };

      // Emit to both the unfollower and the unfollowed user's rooms
      io.to(`user:${followingId}`).emit('user:unfollowed', eventData);
      io.to(`user:${userId}`).emit('user:unfollowed', eventData);

      logger.debug(`Emitted user:unfollowed event - ${userId} unfollowed ${followingId}`);
    }

    return res.json({ success: true });
  } catch (error) {
    logger.error('Error emitting unfollow event:', { userId: req.user?.id, followingId: req.body.followingId, error });
    return res.status(500).json({ message: 'Error emitting unfollow event' });
  }
});

export default router;
