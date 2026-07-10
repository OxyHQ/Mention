import express, { Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import StarterPack, { IStarterPack } from '../models/StarterPack';
import { escapeRegex } from '../utils/textProcessing';
import { resolveUserSummaries, isFallbackUserSummary } from '../services/PostHydrationService';
import type { PostUser } from '@mention/shared-types';
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

function syncPackMembershipChange(
  packId: string,
  ownerId: string,
  previousMemberIds: string[],
  nextMemberIds: string[],
): void {
  void endorsementSignalService
    .syncScopeMembershipChange('starterPack', packId, ownerId, previousMemberIds, nextMemberIds)
    .catch((error) => logger.warn(`[StarterPacks] endorsement membership sync failed for ${packId}:`, error));
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
 * A member in the `GET /starter-packs/:id` detail response — the canonical Oxy
 * {@link PostUser} (Oxy owns identity, same shape as `post.user` / Who-to-follow):
 * `name.displayName`, `avatar` file id, `username`. The client renders it with
 * the same pattern (`getNormalizedUserHandle` + Bloom `ImageResolver`).
 */
type StarterPackMember = PostUser;

/**
 * Resolve a starter pack's members to ready-to-render summaries server-side, in
 * the SAME order as `memberOxyUserIds`.
 *
 * Member identity MUST be resolved on the backend: {@link resolveUserSummaries}
 * goes through the Oxy bulk `/users/by-ids` endpoint, which requires a SERVICE
 * credential that only exists on the server. A browser client calling
 * `getUsersByIds` silently resolves nothing (the SDK swallows the missing-token
 * error and returns `[]`), which is exactly what left the detail screen showing
 * "0 accounts". This mirrors the list path's {@link enrichWithMemberAvatars}.
 *
 * Ids that don't resolve to a real Oxy user (deleted/unknown — the resolver
 * returns its degraded fallback summary) are skipped so we never render a
 * nameless/handle-less placeholder row. Best-effort: a resolution failure
 * returns `[]` so the detail still renders (the caller keeps `memberCount`).
 */
async function hydratePackMembers(memberIds: string[]): Promise<StarterPackMember[]> {
  if (memberIds.length === 0) return [];
  try {
    const summaries = await resolveUserSummaries(memberIds);
    const members: StarterPackMember[] = [];
    for (const id of memberIds) {
      const resolved = summaries.get(id);
      if (!resolved || isFallbackUserSummary(resolved.user)) continue;
      members.push(resolved.user);
    }
    return members;
  } catch (error) {
    logger.warn('[StarterPacks] Failed to resolve members for detail', {
      memberCount: memberIds.length,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return [];
  }
}

/**
 * Enrich a page of starter packs with `memberAvatars` (≤8 resolved URLs) and
 * `memberCount`.
 *
 * Avatar resolution is delegated to {@link resolveUserSummaries} — the SAME
 * batched, Redis-backed (`usersummary:v1:`) author-summary resolver the feed
 * hydration path uses. This collapses what was a per-unique-member
 * `oxy.getUserById` HTTP fan-out (the classic N+1, served only by the SDK's
 * separate 5-minute in-process cache) into a single bulk service call for the
 * cache misses, and unifies the avatar staleness window with the feed (one
 * 10-minute cache instead of two divergent ones). The resolved summary already
 * carries the final, ready-to-render avatar URL, so the output is identical.
 */
async function enrichWithMemberAvatars(packs: LeanStarterPack[]): Promise<StarterPackListItem[]> {
  const uniqueMemberIds = new Set<string>();
  for (const pack of packs) {
    for (const id of (pack.memberOxyUserIds ?? []).slice(0, LIST_AVATAR_LIMIT)) {
      uniqueMemberIds.add(id);
    }
  }

  const avatarById = new Map<string, string>();
  if (uniqueMemberIds.size > 0) {
    try {
      const summaries = await resolveUserSummaries(Array.from(uniqueMemberIds));
      for (const [memberId, { user }] of summaries) {
        // Bare Oxy file id (or mirrored URL) — the client resolves it via Bloom's
        // ImageResolver, same as every other avatar surface.
        if (typeof user.avatar === 'string' && user.avatar.length > 0) {
          avatarById.set(memberId, user.avatar);
        }
      }
    } catch (error) {
      // Avatar enrichment is best-effort: a resolution failure must never fail
      // the list response — packs still render with `memberCount` and no avatars.
      logger.warn('[StarterPacks] Failed to resolve member avatars for list', {
        memberCount: uniqueMemberIds.size,
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

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

// List starter packs — public read with OPTIONAL auth. Three modes:
//   - mine=true       → the authenticated viewer's own packs (empty when anon)
//   - userId=<oxyId>  → a specific owner's packs (a profile's "Starter Packs" tab)
//   - neither         → public discovery (all packs, most-used first)
// The write routes below enforce auth internally.
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const viewerId = req.user?.id;
    const mine = typeof req.query.mine === 'string' ? req.query.mine : undefined;
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const ownerId = typeof req.query.userId === 'string' ? req.query.userId.trim() : '';

    const q: Record<string, unknown> = {};
    let ownerScoped = false;
    if (mine === 'true') {
      // "My packs" requires identity; an anonymous viewer owns nothing.
      if (!viewerId) return res.json({ items: [], total: 0 });
      q.ownerOxyUserId = viewerId;
      ownerScoped = true;
    } else if (ownerId.length > 0) {
      // A specific profile's packs (foreign-profile tab passes `userId`).
      q.ownerOxyUserId = ownerId;
      ownerScoped = true;
    }
    if (search) {
      const escaped = escapeRegex(search);
      q.$or = [
        { name: { $regex: escaped, $options: 'i' } },
        { description: { $regex: escaped, $options: 'i' } },
      ];
    }

    // Owner-scoped views read best most-recent-first; discovery ranks by usage.
    const sort: Record<string, 1 | -1> = ownerScoped
      ? { updatedAt: -1 }
      : { useCount: -1, createdAt: -1 };
    const items = await StarterPack.find(q).sort(sort).limit(50).lean<LeanStarterPack[]>();
    const enriched = await enrichWithMemberAvatars(items);
    res.json({ items: enriched, total: enriched.length });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list starter packs' });
  }
});

// Get starter pack — public read with optional auth (shared links resolve while
// the session is still restoring). No owner-only fields are exposed.
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const pack = await StarterPack.findById(req.params.id).lean();
    if (!pack) return res.status(404).json({ error: 'Starter pack not found' });
    // Hydrate members server-side (the browser has no service credential for the
    // bulk user lookup). `members` is ordered to match `memberOxyUserIds`;
    // `memberCount` mirrors the list response for label parity.
    const memberIds = pack.memberOxyUserIds ?? [];
    const members = await hydratePackMembers(memberIds);
    res.json({ ...pack, members, memberCount: memberIds.length });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get starter pack' });
  }
});

// Update starter pack
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const pack = await StarterPack.findById(req.params.id);
    if (!pack) return res.status(404).json({ error: 'Starter pack not found' });
    if (pack.ownerOxyUserId !== userId) return res.status(403).json({ error: 'Not allowed' });

    const { name, description, memberOxyUserIds } = req.body || {};
    if (name !== undefined) pack.name = String(name);
    if (description !== undefined) pack.description = String(description);
    const previousMemberIds = [...(pack.memberOxyUserIds || [])];
    if (Array.isArray(memberOxyUserIds)) {
      if (memberOxyUserIds.length > MAX_MEMBERS) return res.status(400).json({ error: `Maximum ${MAX_MEMBERS} members allowed` });
      pack.memberOxyUserIds = memberOxyUserIds;
    }
    await pack.save();
    if (Array.isArray(memberOxyUserIds)) {
      syncPackMembershipChange(String(pack._id), pack.ownerOxyUserId, previousMemberIds, pack.memberOxyUserIds || []);
    } else {
      syncPackEndorsements(String(pack._id));
    }
    res.json(pack);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update starter pack' });
  }
});

// Delete starter pack
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
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
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
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
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const { userIds } = req.body || {};
    const pack = await StarterPack.findById(req.params.id);
    if (!pack) return res.status(404).json({ error: 'Starter pack not found' });
    if (pack.ownerOxyUserId !== userId) return res.status(403).json({ error: 'Not allowed' });

    const previousMemberIds = [...(pack.memberOxyUserIds || [])];
    const toRemove = new Set(Array.isArray(userIds) ? userIds : []);
    pack.memberOxyUserIds = (pack.memberOxyUserIds || []).filter(id => !toRemove.has(id));
    await pack.save();
    syncPackMembershipChange(String(pack._id), pack.ownerOxyUserId, previousMemberIds, pack.memberOxyUserIds || []);
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
