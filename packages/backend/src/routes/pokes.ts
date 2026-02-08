import { Router, Response } from 'express';
import { AuthRequest } from '../types/auth';
import Poke from '../models/Poke';
import { createNotification } from '../utils/notificationUtils';
import { logger } from '../utils/logger';

const router = Router();

// Check if current user has poked a user
router.get('/:userId/status', async (req: AuthRequest, res: Response) => {
  try {
    const pokerId = req.user?.id;
    const { userId } = req.params;
    if (!pokerId) return res.status(401).json({ message: 'Unauthorized' });
    if (!userId) return res.status(400).json({ message: 'userId is required' });

    const exists = await Poke.exists({ pokerId, pokedId: userId });
    return res.json({ poked: !!exists });
  } catch (error) {
    logger.error('[Pokes] Error checking poke status:', { userId: req.user?.id, targetId: req.params.userId, error });
    return res.status(500).json({ message: 'Error checking poke status' });
  }
});

// Poke a user
router.post('/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const pokerId = req.user?.id;
    const { userId } = req.params;
    if (!pokerId) return res.status(401).json({ message: 'Unauthorized' });
    if (!userId) return res.status(400).json({ message: 'userId is required' });
    if (userId === pokerId) return res.status(400).json({ message: 'Cannot poke yourself' });

    await Poke.updateOne(
      { pokerId, pokedId: userId },
      { $setOnInsert: { pokerId, pokedId: userId } },
      { upsert: true }
    );

    // Send notification to the poked user
    await createNotification({
      recipientId: userId,
      actorId: pokerId,
      type: 'poke',
      entityId: pokerId,
      entityType: 'profile',
    });

    return res.json({ poked: true });
  } catch (error: any) {
    if (error?.code === 11000) {
      return res.json({ poked: true });
    }
    logger.error('[Pokes] Error poking user:', { userId: req.user?.id, targetId: req.params.userId, error });
    return res.status(500).json({ message: 'Error poking user' });
  }
});

// Undo poke
router.delete('/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const pokerId = req.user?.id;
    const { userId } = req.params;
    if (!pokerId) return res.status(401).json({ message: 'Unauthorized' });
    if (!userId) return res.status(400).json({ message: 'userId is required' });

    await Poke.deleteOne({ pokerId, pokedId: userId });
    return res.json({ poked: false });
  } catch (error) {
    logger.error('[Pokes] Error undoing poke:', { userId: req.user?.id, targetId: req.params.userId, error });
    return res.status(500).json({ message: 'Error undoing poke' });
  }
});

export default router;
