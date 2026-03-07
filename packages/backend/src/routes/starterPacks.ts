import express, { Request, Response } from 'express';
import StarterPack from '../models/StarterPack';

const router = express.Router();

const MAX_MEMBERS = 150;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface AuthRequest extends Request { user?: { id: string } }

// Create starter pack
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { name, description, memberOxyUserIds = [] } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const members = Array.isArray(memberOxyUserIds) ? memberOxyUserIds : [];
    if (members.length > MAX_MEMBERS) return res.status(400).json({ error: `Maximum ${MAX_MEMBERS} members allowed` });

    const pack = await StarterPack.create({
      ownerOxyUserId: userId,
      name: String(name),
      description: description ? String(description) : undefined,
      memberOxyUserIds: members,
    });

    res.status(201).json(pack);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create starter pack' });
  }
});

// List starter packs (mine or discover)
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const { mine, search } = req.query as any;

    const q: any = {};
    if (mine === 'true') {
      q.ownerOxyUserId = userId;
    }
    if (search) {
      const escaped = escapeRegex(String(search));
      q.$or = [
        { name: { $regex: escaped, $options: 'i' } },
        { description: { $regex: escaped, $options: 'i' } },
      ];
    }

    const sort: any = mine === 'true' ? { updatedAt: -1 } : { useCount: -1, createdAt: -1 };
    const items = await StarterPack.find(q).sort(sort).limit(50).lean();
    res.json({ items, total: items.length });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list starter packs' });
  }
});

// Get starter pack
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const pack = await StarterPack.findById(req.params.id).lean();
    if (!pack) return res.status(404).json({ error: 'Starter pack not found' });
    res.json(pack);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get starter pack' });
  }
});

// Update starter pack
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const pack = await StarterPack.findById(req.params.id);
    if (!pack) return res.status(404).json({ error: 'Starter pack not found' });
    if (pack.ownerOxyUserId !== userId) return res.status(403).json({ error: 'Not allowed' });

    const { name, description, memberOxyUserIds } = req.body || {};
    if (name !== undefined) pack.name = String(name);
    if (description !== undefined) pack.description = String(description);
    if (Array.isArray(memberOxyUserIds)) {
      if (memberOxyUserIds.length > MAX_MEMBERS) return res.status(400).json({ error: `Maximum ${MAX_MEMBERS} members allowed` });
      pack.memberOxyUserIds = memberOxyUserIds;
    }
    await pack.save();
    res.json(pack);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update starter pack' });
  }
});

// Delete starter pack
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const pack = await StarterPack.findById(req.params.id);
    if (!pack) return res.status(404).json({ error: 'Starter pack not found' });
    if (pack.ownerOxyUserId !== userId) return res.status(403).json({ error: 'Not allowed' });
    await pack.deleteOne();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete starter pack' });
  }
});

// Add members
router.post('/:id/members', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { userIds } = req.body || {};
    const pack = await StarterPack.findById(req.params.id);
    if (!pack) return res.status(404).json({ error: 'Starter pack not found' });
    if (pack.ownerOxyUserId !== userId) return res.status(403).json({ error: 'Not allowed' });

    const set = new Set([...(pack.memberOxyUserIds || []), ...(Array.isArray(userIds) ? userIds : [])]);
    if (set.size > MAX_MEMBERS) return res.status(400).json({ error: `Maximum ${MAX_MEMBERS} members allowed` });
    pack.memberOxyUserIds = Array.from(set);
    await pack.save();
    res.json(pack);
  } catch (error) {
    res.status(500).json({ error: 'Failed to add members' });
  }
});

// Remove members
router.delete('/:id/members', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { userIds } = req.body || {};
    const pack = await StarterPack.findById(req.params.id);
    if (!pack) return res.status(404).json({ error: 'Starter pack not found' });
    if (pack.ownerOxyUserId !== userId) return res.status(403).json({ error: 'Not allowed' });

    const toRemove = new Set(Array.isArray(userIds) ? userIds : []);
    pack.memberOxyUserIds = (pack.memberOxyUserIds || []).filter(id => !toRemove.has(id));
    await pack.save();
    res.json(pack);
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove members' });
  }
});

// Use starter pack (increment count, return member IDs for client-side following)
router.post('/:id/use', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const pack = await StarterPack.findByIdAndUpdate(
      req.params.id,
      { $inc: { useCount: 1 } },
      { new: true }
    ).lean();
    if (!pack) return res.status(404).json({ error: 'Starter pack not found' });

    res.json({ memberOxyUserIds: pack.memberOxyUserIds, useCount: pack.useCount });
  } catch (error) {
    res.status(500).json({ error: 'Failed to use starter pack' });
  }
});

export default router;
