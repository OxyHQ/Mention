import { Router, Response } from 'express';
import { AuthRequest } from '../types/auth';
import PostSubscription from '../models/PostSubscription';
import { logger } from '../utils/logger';

const router = Router();

// Get subscription status for the current user to an author
router.get('/:authorId/status', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { authorId } = req.params;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!authorId) return res.status(400).json({ message: 'authorId is required' });

    const exists = await PostSubscription.exists({ subscriberId: userId, authorId });
    return res.json({ subscribed: !!exists });
  } catch (error) {
    logger.error('[Subscriptions] Error checking subscription status:', error);
    return res.status(500).json({ message: 'Error checking subscription status' });
  }
});

// Subscribe current user to author posts
router.post('/:authorId', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { authorId } = req.params;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!authorId) return res.status(400).json({ message: 'authorId is required' });
    if (authorId === userId) return res.status(400).json({ message: 'Cannot subscribe to yourself' });

    await PostSubscription.updateOne(
      { subscriberId: userId, authorId },
      { $setOnInsert: { subscriberId: userId, authorId } },
      { upsert: true }
    );
    return res.json({ subscribed: true });
  } catch (error: any) {
    if (error?.code === 11000) {
      return res.json({ subscribed: true });
    }
    logger.error('[Subscriptions] Error subscribing to author:', error);
    return res.status(500).json({ message: 'Error subscribing to author' });
  }
});

// Unsubscribe current user from author posts
router.delete('/:authorId', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { authorId } = req.params;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!authorId) return res.status(400).json({ message: 'authorId is required' });

    await PostSubscription.deleteOne({ subscriberId: userId, authorId });
    return res.json({ subscribed: false });
  } catch (error) {
    logger.error('[Subscriptions] Error unsubscribing from author:', error);
    return res.status(500).json({ message: 'Error unsubscribing from author' });
  }
});

// Optional: list all subscriptions for current user
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const subs = await PostSubscription.find({ subscriberId: userId }).lean();
    return res.json({ subscriptions: subs });
  } catch (error) {
    logger.error('[Subscriptions] Error listing subscriptions:', error);
    return res.status(500).json({ message: 'Error listing subscriptions' });
  }
});

export default router;
