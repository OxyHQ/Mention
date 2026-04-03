import { Router, Response } from 'express';
import { AuthRequest } from '../types/auth';
import Poke from '../models/Poke';
import { createNotification } from '../utils/notificationUtils';
import { logger } from '../utils/logger';
import { oxy } from '../../server';

const router = Router();

/** Resolve an array of Oxy user IDs into profile objects (best-effort). */
async function resolveUsers(ids: string[]): Promise<Map<string, any>> {
  const map = new Map<string, any>();
  await Promise.all(
    ids.map(async (id) => {
      try {
        const user = await oxy.getUserById(id);
        if (user) map.set(id, user);
      } catch { /* skip unresolvable */ }
    }),
  );
  return map;
}

function toUserSummary(user: any, id: string) {
  return {
    id: user?.id || user?._id || id,
    username: user?.username || id,
    name: user?.name?.full || user?.name || user?.username || id,
    avatar: user?.avatar,
    bio: user?.profile?.bio || user?.bio,
  };
}

// List pokes received by the current user
router.get('/received', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const pokes = await Poke.find({ pokedId: userId }).sort({ createdAt: -1 }).lean();
    const pokerIds = pokes.map((p) => p.pokerId);
    const profiles = await resolveUsers(pokerIds);

    // Also check which ones the current user has poked back
    const pokedBack = await Poke.find({ pokerId: userId, pokedId: { $in: pokerIds } }).lean();
    const pokedBackSet = new Set(pokedBack.map((p) => p.pokedId));

    const items = pokes.map((p) => ({
      id: p._id,
      user: toUserSummary(profiles.get(p.pokerId), p.pokerId),
      pokeCount: 1,
      pokedBack: pokedBackSet.has(p.pokerId),
      createdAt: p.createdAt,
    }));

    return res.json({ pokes: items });
  } catch (error) {
    logger.error('[Pokes] Error listing received pokes:', { userId: req.user?.id, error });
    return res.status(500).json({ message: 'Error listing received pokes' });
  }
});

// List pokes sent by the current user
router.get('/sent', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const pokes = await Poke.find({ pokerId: userId }).sort({ createdAt: -1 }).lean();
    const pokedIds = pokes.map((p) => p.pokedId);
    const profiles = await resolveUsers(pokedIds);

    const items = pokes.map((p) => ({
      id: p._id,
      user: toUserSummary(profiles.get(p.pokedId), p.pokedId),
      createdAt: p.createdAt,
    }));

    return res.json({ pokes: items });
  } catch (error) {
    logger.error('[Pokes] Error listing sent pokes:', { userId: req.user?.id, error });
    return res.status(500).json({ message: 'Error listing sent pokes' });
  }
});

// Suggested users to poke (followers/following not yet poked)
router.get('/suggested', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    // Get users the current user has already poked
    const existingPokes = await Poke.find({ pokerId: userId }).lean();
    const alreadyPokedIds = new Set(existingPokes.map((p) => p.pokedId));

    // Get followers and following via OxyServices
    let followerIds: string[] = [];
    let followingIds: string[] = [];
    try {
      const followersResult: any = await oxy.getUserFollowers(userId);
      const fList = followersResult?.followers || followersResult || [];
      followerIds = fList.map((u: any) => String(u.id || u._id || u.userID));
    } catch { /* ignore */ }
    try {
      const followingResult: any = await oxy.getUserFollowing(userId);
      const fList = followingResult?.following || followingResult || [];
      followingIds = fList.map((u: any) => String(u.id || u._id || u.userID));
    } catch { /* ignore */ }

    // Merge and deduplicate, excluding self and already-poked
    const candidateIds = [...new Set([...followerIds, ...followingIds])]
      .filter((id) => id !== userId && !alreadyPokedIds.has(id));

    // Limit to 20 suggestions
    const limitedIds = candidateIds.slice(0, 20);
    const profiles = await resolveUsers(limitedIds);

    const items = limitedIds
      .filter((id) => profiles.has(id))
      .map((id) => ({
        user: toUserSummary(profiles.get(id), id),
      }));

    return res.json({ suggestions: items });
  } catch (error) {
    logger.error('[Pokes] Error listing suggested pokes:', { userId: req.user?.id, error });
    return res.status(500).json({ message: 'Error listing suggested pokes' });
  }
});

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
      recipientId: String(userId),
      actorId: String(pokerId),
      type: 'poke',
      entityId: String(pokerId),
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
