import { Router, Response } from 'express';
import Mute from '../models/Mute';
import { AuthRequest } from '../types/auth';
import { logger } from '../utils/logger';

const router = Router();

/**
 * Mute a user
 * POST /api/mute
 */
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { mutedId } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!mutedId) {
      return res.status(400).json({ message: 'mutedId is required' });
    }

    // Prevent self-muting
    if (userId === mutedId) {
      return res.status(400).json({ message: 'Cannot mute yourself' });
    }

    // Check if already muted
    const existingMute = await Mute.findOne({ userId, mutedId });
    if (existingMute) {
      return res.status(200).json({
        message: 'User already muted',
        mute: existingMute
      });
    }

    // Create mute record
    const mute = new Mute({
      userId,
      mutedId,
      createdAt: new Date()
    });

    await mute.save();

    logger.debug(`User ${userId} muted ${mutedId}`);

    res.status(201).json({
      message: 'User muted successfully',
      mute
    });
  } catch (error) {
    logger.error('Error muting user:', error);
    res.status(500).json({
      message: 'Error muting user',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Unmute a user
 * DELETE /api/mute/:mutedId
 */
router.delete('/:mutedId', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { mutedId } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!mutedId) {
      return res.status(400).json({ message: 'mutedId is required' });
    }

    // Delete mute record
    const result = await Mute.findOneAndDelete({ userId, mutedId });

    if (!result) {
      return res.status(404).json({ message: 'Mute not found' });
    }

    logger.debug(`User ${userId} unmuted ${mutedId}`);

    res.json({
      message: 'User unmuted successfully'
    });
  } catch (error) {
    logger.error('Error unmuting user:', error);
    res.status(500).json({
      message: 'Error unmuting user',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Get muted users list for current user
 * GET /api/mute
 */
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const mutes = await Mute.find({ userId })
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      mutes,
      count: mutes.length
    });
  } catch (error) {
    logger.error('Error fetching muted users:', error);
    res.status(500).json({
      message: 'Error fetching muted users',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Check if a user is muted
 * GET /api/mute/check/:userId
 */
router.get('/check/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const currentUserId = req.user?.id;
    const { userId } = req.params;

    if (!currentUserId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!userId) {
      return res.status(400).json({ message: 'userId is required' });
    }

    const mute = await Mute.findOne({
      userId: currentUserId,
      mutedId: userId
    });

    res.json({
      isMuted: !!mute
    });
  } catch (error) {
    logger.error('Error checking mute status:', error);
    res.status(500).json({
      message: 'Error checking mute status',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
