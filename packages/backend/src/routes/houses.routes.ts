import { Router, Response } from 'express';
import House, { HouseMemberRole, IHouseMember } from '../models/House';
import Room, { RoomStatus } from '../models/Room';
import Series from '../models/Series';
import { AuthRequest } from '../types/auth';
import { logger } from '../utils/logger';

const router = Router();

/**
 * Create a house
 * POST /api/houses
 */
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { name, description, avatar, coverImage, tags, isPublic } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ message: 'Name is required' });
    }

    const house = new House({
      name: name.trim(),
      description: description ? String(description).trim() : undefined,
      avatar: avatar ? String(avatar).trim() : undefined,
      coverImage: coverImage ? String(coverImage).trim() : undefined,
      createdBy: userId,
      isPublic: typeof isPublic === 'boolean' ? isPublic : true,
      tags: Array.isArray(tags) ? tags.map((t: unknown) => String(t).trim()).filter(Boolean) : [],
      members: [
        {
          userId,
          role: HouseMemberRole.OWNER,
          joinedAt: new Date(),
        },
      ],
    });

    await house.save();

    logger.info(`House created: ${house._id} by ${userId}`);

    res.status(201).json({
      message: 'House created successfully',
      house,
    });
  } catch (error) {
    logger.error('Error creating house:', { userId: req.user?.id, error });
    res.status(500).json({
      message: 'Error creating house',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * List public houses (paginated, cursor-based)
 * GET /api/houses
 */
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { limit = '20', cursor, search } = req.query;

    const query: Record<string, unknown> = {
      isPublic: true,
    };

    // Cursor-based pagination
    if (cursor && typeof cursor === 'string') {
      query._id = { $lt: cursor };
    }

    // Optional text search
    if (search && typeof search === 'string' && search.trim().length > 0) {
      query.$text = { $search: search.trim() };
    }

    const limitNum = Math.min(Math.max(parseInt(limit as string, 10) || 20, 1), 100);

    const houses = await House.find(query)
      .sort({ createdAt: -1 })
      .limit(limitNum + 1)
      .lean();

    const hasMore = houses.length > limitNum;
    const housesToReturn = hasMore ? houses.slice(0, limitNum) : houses;
    const nextCursor = hasMore && housesToReturn.length > 0
      ? housesToReturn[housesToReturn.length - 1]._id.toString()
      : undefined;

    res.json({
      houses: housesToReturn,
      hasMore,
      nextCursor,
    });
  } catch (error) {
    logger.error('Error fetching houses:', { userId: req.user?.id, error, query: req.query });
    res.status(500).json({
      message: 'Error fetching houses',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get house details
 * GET /api/houses/:id
 */
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const house = await House.findById(id).lean();

    if (!house) {
      return res.status(404).json({ message: 'House not found' });
    }

    res.json({ house });
  } catch (error) {
    logger.error('Error fetching house:', { userId: req.user?.id, houseId: req.params.id, error });
    res.status(500).json({
      message: 'Error fetching house',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Update house (admin/owner only)
 * PATCH /api/houses/:id
 */
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    const { name, description, avatar, coverImage, tags, isPublic } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const house = await House.findById(id);

    if (!house) {
      return res.status(404).json({ message: 'House not found' });
    }

    // Must be admin or owner to update
    if (!house.hasRole(userId, HouseMemberRole.ADMIN)) {
      return res.status(403).json({ message: 'Only admins or owner can update the house' });
    }

    // Apply updates
    if (name !== undefined && typeof name === 'string' && name.trim().length > 0) {
      house.name = name.trim();
    }
    if (description !== undefined) {
      house.description = description ? String(description).trim() : undefined;
    }
    if (avatar !== undefined) {
      house.avatar = avatar ? String(avatar).trim() : undefined;
    }
    if (coverImage !== undefined) {
      house.coverImage = coverImage ? String(coverImage).trim() : undefined;
    }
    if (tags !== undefined && Array.isArray(tags)) {
      house.tags = tags.map((t: unknown) => String(t).trim()).filter(Boolean);
    }
    if (typeof isPublic === 'boolean') {
      house.isPublic = isPublic;
    }

    await house.save();

    logger.info(`House updated: ${id} by ${userId}`);

    res.json({
      message: 'House updated successfully',
      house,
    });
  } catch (error) {
    logger.error('Error updating house:', { userId: req.user?.id, houseId: req.params.id, error });
    res.status(500).json({
      message: 'Error updating house',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Delete house (owner only)
 * DELETE /api/houses/:id
 */
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const house = await House.findById(id);

    if (!house) {
      return res.status(404).json({ message: 'House not found' });
    }

    // Only the owner can delete the house
    if (!house.hasRole(userId, HouseMemberRole.OWNER)) {
      return res.status(403).json({ message: 'Only the owner can delete the house' });
    }

    await House.findByIdAndDelete(id);

    logger.info(`House deleted: ${id} by ${userId}`);

    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting house:', { userId: req.user?.id, houseId: req.params.id, error });
    res.status(500).json({
      message: 'Error deleting house',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Add member (admin/owner only)
 * POST /api/houses/:id/members
 * Body: { userId: string, role?: string }
 */
router.post('/:id/members', async (req: AuthRequest, res: Response) => {
  try {
    const currentUserId = req.user?.id;
    const { id } = req.params;
    const { userId: targetUserId, role } = req.body;

    if (!currentUserId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!targetUserId || typeof targetUserId !== 'string') {
      return res.status(400).json({ message: 'userId is required' });
    }

    const house = await House.findById(id);

    if (!house) {
      return res.status(404).json({ message: 'House not found' });
    }

    // Must be admin or owner to add members
    if (!house.hasRole(currentUserId, HouseMemberRole.ADMIN)) {
      return res.status(403).json({ message: 'Only admins or owner can add members' });
    }

    // Check if already a member
    if (house.isMember(targetUserId)) {
      return res.status(400).json({ message: 'User is already a member' });
    }

    // Validate role (cannot assign owner role)
    const validRoles: HouseMemberRole[] = [HouseMemberRole.MEMBER, HouseMemberRole.HOST, HouseMemberRole.ADMIN];
    const assignedRole: HouseMemberRole = role && validRoles.includes(role as HouseMemberRole)
      ? (role as HouseMemberRole)
      : HouseMemberRole.MEMBER;

    house.members.push({
      userId: targetUserId,
      role: assignedRole,
      joinedAt: new Date(),
    } as IHouseMember);

    await house.save();

    logger.info(`User ${targetUserId} added to house ${id} as ${assignedRole} by ${currentUserId}`);

    res.json({
      message: 'Member added successfully',
      house,
    });
  } catch (error) {
    logger.error('Error adding member:', { userId: req.user?.id, houseId: req.params.id, error });
    res.status(500).json({
      message: 'Error adding member',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Update member role (admin/owner only, cannot demote owner)
 * PATCH /api/houses/:id/members/:userId
 * Body: { role: string }
 */
router.patch('/:id/members/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const currentUserId = req.user?.id;
    const { id, userId: targetUserId } = req.params;
    const { role } = req.body;

    if (!currentUserId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!role || typeof role !== 'string') {
      return res.status(400).json({ message: 'role is required' });
    }

    const house = await House.findById(id);

    if (!house) {
      return res.status(404).json({ message: 'House not found' });
    }

    // Must be admin or owner to update member roles
    if (!house.hasRole(currentUserId, HouseMemberRole.ADMIN)) {
      return res.status(403).json({ message: 'Only admins or owner can update member roles' });
    }

    // Find the target member
    const targetMember = house.members.find((m: IHouseMember) => m.userId === targetUserId);
    if (!targetMember) {
      return res.status(404).json({ message: 'Member not found' });
    }

    // Cannot demote or change the owner's role
    if (targetMember.role === HouseMemberRole.OWNER) {
      return res.status(403).json({ message: 'Cannot change the owner\'s role' });
    }

    // Cannot assign owner role through this endpoint
    if (role === HouseMemberRole.OWNER) {
      return res.status(400).json({ message: 'Cannot assign owner role through this endpoint' });
    }

    // Validate the new role
    const validRoles: HouseMemberRole[] = [HouseMemberRole.MEMBER, HouseMemberRole.HOST, HouseMemberRole.ADMIN];
    if (!validRoles.includes(role as HouseMemberRole)) {
      return res.status(400).json({ message: 'Invalid role' });
    }

    // Non-owners cannot promote to admin
    const currentMemberRole = house.getMemberRole(currentUserId);
    if (role === HouseMemberRole.ADMIN && currentMemberRole !== HouseMemberRole.OWNER) {
      return res.status(403).json({ message: 'Only the owner can promote members to admin' });
    }

    targetMember.role = role as HouseMemberRole;
    await house.save();

    logger.info(`User ${targetUserId} role updated to ${role} in house ${id} by ${currentUserId}`);

    res.json({
      message: 'Member role updated successfully',
      house,
    });
  } catch (error) {
    logger.error('Error updating member role:', { userId: req.user?.id, houseId: req.params.id, targetUserId: req.params.userId, error });
    res.status(500).json({
      message: 'Error updating member role',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Remove member (admin/owner, or self-leave)
 * DELETE /api/houses/:id/members/:userId
 */
router.delete('/:id/members/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const currentUserId = req.user?.id;
    const { id, userId: targetUserId } = req.params;

    if (!currentUserId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const house = await House.findById(id);

    if (!house) {
      return res.status(404).json({ message: 'House not found' });
    }

    const isSelfLeave = currentUserId === targetUserId;

    // If not self-leave, must be admin or owner
    if (!isSelfLeave && !house.hasRole(currentUserId, HouseMemberRole.ADMIN)) {
      return res.status(403).json({ message: 'Only admins or owner can remove members' });
    }

    // Find the target member
    const targetMember = house.members.find((m: IHouseMember) => m.userId === targetUserId);
    if (!targetMember) {
      return res.status(404).json({ message: 'Member not found' });
    }

    // Cannot remove the owner
    if (targetMember.role === HouseMemberRole.OWNER) {
      return res.status(403).json({ message: 'Cannot remove the owner from the house' });
    }

    // Non-owners cannot remove admins
    if (targetMember.role === HouseMemberRole.ADMIN && !isSelfLeave) {
      const currentRole = house.getMemberRole(currentUserId);
      if (currentRole !== HouseMemberRole.OWNER) {
        return res.status(403).json({ message: 'Only the owner can remove admins' });
      }
    }

    // Remove the member
    house.members = house.members.filter((m: IHouseMember) => m.userId !== targetUserId);
    await house.save();

    logger.info(`User ${targetUserId} removed from house ${id} by ${currentUserId}${isSelfLeave ? ' (self-leave)' : ''}`);

    res.json({
      message: isSelfLeave ? 'Left house successfully' : 'Member removed successfully',
    });
  } catch (error) {
    logger.error('Error removing member:', { userId: req.user?.id, houseId: req.params.id, targetUserId: req.params.userId, error });
    res.status(500).json({
      message: 'Error removing member',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * List rooms belonging to a house (paginated)
 * GET /api/houses/:id/rooms
 */
router.get('/:id/rooms', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { status, type, limit = '20', cursor } = req.query;

    // Verify house exists
    const houseExists = await House.exists({ _id: id });
    if (!houseExists) {
      return res.status(404).json({ message: 'House not found' });
    }

    const query: Record<string, unknown> = {
      houseId: id,
      archived: { $ne: true },
    };

    // Filter by status
    if (status && typeof status === 'string') {
      const validStatuses = Object.values(RoomStatus);
      if (validStatuses.includes(status as RoomStatus)) {
        query.status = status;
      }
    } else {
      query.status = { $in: [RoomStatus.LIVE, RoomStatus.SCHEDULED] };
    }

    // Filter by type
    if (type && typeof type === 'string') {
      query.type = type;
    }

    // Cursor-based pagination
    if (cursor && typeof cursor === 'string') {
      query._id = { $lt: cursor };
    }

    const limitNum = Math.min(Math.max(parseInt(limit as string, 10) || 20, 1), 100);

    const rooms = await Room.find(query)
      .sort({ createdAt: -1 })
      .limit(limitNum + 1)
      .lean();

    const hasMore = rooms.length > limitNum;
    const roomsToReturn = hasMore ? rooms.slice(0, limitNum) : rooms;
    const nextCursor = hasMore && roomsToReturn.length > 0
      ? roomsToReturn[roomsToReturn.length - 1]._id.toString()
      : undefined;

    res.json({
      rooms: roomsToReturn,
      hasMore,
      nextCursor,
    });
  } catch (error) {
    logger.error('Error fetching house rooms:', { userId: req.user?.id, houseId: req.params.id, error });
    res.status(500).json({
      message: 'Error fetching house rooms',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * List series belonging to a house
 * GET /api/houses/:id/series
 */
router.get('/:id/series', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    // Verify house exists
    const houseExists = await House.exists({ _id: id });
    if (!houseExists) {
      return res.status(404).json({ message: 'House not found' });
    }

    const seriesList = await Series.find({
      houseId: id,
      isActive: true,
    })
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      series: seriesList,
    });
  } catch (error) {
    logger.error('Error fetching house series:', { userId: req.user?.id, houseId: req.params.id, error });
    res.status(500).json({
      message: 'Error fetching house series',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
