import express, { Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import type { User as OxyUser } from '@oxyhq/core';
import StarterPack, { IStarterPack } from '../models/StarterPack';
import { escapeRegex } from '../utils/textProcessing';
import { oxy } from '../../server';
import { resolveAvatarUrl } from '../utils/mediaResolver';
import { logger } from '../utils/logger';
import { endorsementSignalService } from '../services/EndorsementSignalService';

/**
 * Fire-and-forget endorsement re-sync for a starter pack whose membership
 * changed. Never blocks or fails the request — Oxy reputation signals are
 * eventually consistent (the outbox retries on failure).
 */
function syncPackEndorsements(packId: string): void {
  void endorsementSignalService
    .syncScope('starterPack', packId)
    .catch((error) => logger.warn(`[StarterPacks] endorsement sync failed for ${packId}:`, error));
}

const router = express.Router();

const MAX_MEMBERS = 150;

/** Number of member avatars surfaced per pack in the list response. */
const LIST_AVATAR_LIMIT = 8;

/** A starter pack as returned by `.lean()` — a plain object with `_id`. */
type LeanStarterPack = Pick<
  IStarterPack,
  'ownerOxyUserId' | 'name' | 'description' | 'memberOxyUserIds' | 'usedByOxyUserIds' | 'useCount' | 'createdAt' | 'updatedAt'
> & { _id: unknown };

/** Shape of each item in the `GET /starter-packs` list response. */
interface StarterPackListItem extends LeanStarterPack {
  memberAvatars: string[];
  memberCount: number;
}

/**
 * Resolve a single Oxy member's avatar to a FINAL, ready-to-render URL.
 * Mirrors {@link PostHydrationService}'s actor resolution: prefer `avatar`,
 * fall back to `profileImage`, then run through {@link resolveAvatarUrl} so the
 * frontend never has to construct URLs. Returns `undefined` on any failure or
 * when the member has no avatar so the caller can omit it.
 */
async function resolveMemberAvatar(oxyUserId: string): Promise<string | undefined> {
  try {
    const userData: OxyUser = await oxy.getUserById(oxyUserId);
    const profileImage = (userData as { profileImage?: unknown }).profileImage;
    const rawAvatar: string | undefined = typeof userData.avatar === 'string'
      ? userData.avatar
      : typeof profileImage === 'string'
        ? profileImage
        : undefined;
    return resolveAvatarUrl(rawAvatar);
  } catch (error) {
    logger.warn(`[StarterPacks] Failed to resolve member avatar for ${oxyUserId}:`, error);
    return undefined;
  }
}

/**
 * Enrich a page of starter packs with `memberAvatars` (≤8 resolved URLs) and
 * `memberCount`. Avoids N+1: collects the union of each pack's first
 * {@link LIST_AVATAR_LIMIT} member ids, resolves every unique id ONCE, then maps
 * avatars back per pack preserving member order.
 */
async function enrichWithMemberAvatars(packs: LeanStarterPack[]): Promise<StarterPackListItem[]> {
  const uniqueMemberIds = new Set<string>();
  for (const pack of packs) {
    for (const id of (pack.memberOxyUserIds ?? []).slice(0, LIST_AVATAR_LIMIT)) {
      uniqueMemberIds.add(id);
    }
  }

  const avatarById = new Map<string, string>();
  await Promise.all(
    Array.from(uniqueMemberIds).map(async (memberId) => {
      const avatar = await resolveMemberAvatar(memberId);
      if (avatar) {
        avatarById.set(memberId, avatar);
      }
    }),
  );

  return packs.map((pack) => {
    const members = pack.memberOxyUserIds ?? [];
    const memberAvatars = members
      .slice(0, LIST_AVATAR_LIMIT)
      .map((id) => avatarById.get(id))
      .filter((url): url is string => typeof url === 'string');
    return { ...pack, memberAvatars, memberCount: members.length };
  });
}

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

    syncPackEndorsements(String(pack._id));
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
    const items = await StarterPack.find(q).sort(sort).limit(50).lean<LeanStarterPack[]>();
    const enriched = await enrichWithMemberAvatars(items);
    res.json({ items: enriched, total: enriched.length });
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
    syncPackEndorsements(String(pack._id));
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
    // Capture members BEFORE delete so we can retract their endorsements.
    const ownerId = pack.ownerOxyUserId;
    const memberIds = [...(pack.memberOxyUserIds || [])];
    const packId = String(pack._id);
    await pack.deleteOne();
    void endorsementSignalService
      .syncScopeRemoval('starterPack', packId, ownerId, memberIds)
      .catch((error) => logger.warn(`[StarterPacks] endorsement retraction failed for ${packId}:`, error));
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
    syncPackEndorsements(String(pack._id));
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
    syncPackEndorsements(String(pack._id));
    res.json(pack);
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove members' });
  }
});

// Use starter pack (increment count once per user, return member IDs for client-side following)
router.post('/:id/use', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    // Atomically add user to usedByOxyUserIds and increment count only if not already used
    const pack = await StarterPack.findOneAndUpdate(
      { _id: req.params.id, usedByOxyUserIds: { $ne: userId } },
      { $inc: { useCount: 1 }, $addToSet: { usedByOxyUserIds: userId } },
      { new: true }
    ).lean();

    if (!pack) {
      // Either not found or already used — check which
      const existing = await StarterPack.findById(req.params.id).lean();
      if (!existing) return res.status(404).json({ error: 'Starter pack not found' });
      // Already used — return data without re-incrementing
      return res.json({ memberOxyUserIds: existing.memberOxyUserIds, useCount: existing.useCount, alreadyUsed: true });
    }

    res.json({ memberOxyUserIds: pack.memberOxyUserIds, useCount: pack.useCount });
  } catch (error) {
    res.status(500).json({ error: 'Failed to use starter pack' });
  }
});

export default router;
