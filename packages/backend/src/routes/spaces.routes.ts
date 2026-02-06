import { Router, Response } from 'express';
import Space, { SpaceStatus } from '../models/Space';
import { AuthRequest } from '../types/auth';
import { logger } from '../utils/logger';

const router = Router();

/**
 * Create a space
 * POST /api/spaces
 */
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { title, description, scheduledStart, maxParticipants, topic, tags } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      return res.status(400).json({ message: 'Title is required' });
    }

    // Validate scheduledStart if provided
    let scheduledStartDate: Date | undefined;
    if (scheduledStart) {
      scheduledStartDate = new Date(scheduledStart);
      if (isNaN(scheduledStartDate.getTime())) {
        return res.status(400).json({ message: 'Invalid scheduledStart date' });
      }
    }

    // Create space
    const space = new Space({
      title: title.trim(),
      description: description ? String(description).trim() : undefined,
      host: userId,
      status: SpaceStatus.SCHEDULED,
      participants: [],
      speakers: [userId], // Host is automatically a speaker
      maxParticipants: maxParticipants && typeof maxParticipants === 'number'
        ? Math.min(Math.max(maxParticipants, 1), 1000)
        : 100,
      scheduledStart: scheduledStartDate,
      topic: topic ? String(topic).trim() : undefined,
      tags: Array.isArray(tags) ? tags.map(t => String(t).trim()).filter(Boolean) : [],
      stats: {
        peakListeners: 0,
        totalJoined: 0
      }
    });

    await space.save();

    logger.info(`Space created: ${space._id} by ${userId}`);

    res.status(201).json({
      message: 'Space created successfully',
      space
    });
  } catch (error) {
    logger.error('Error creating space:', error);
    res.status(500).json({
      message: 'Error creating space',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * List active/scheduled spaces
 * GET /api/spaces
 */
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { status, host, limit = '20', cursor } = req.query;

    const query: any = {};

    // Filter by status
    if (status && typeof status === 'string') {
      const validStatuses = Object.values(SpaceStatus);
      if (validStatuses.includes(status as SpaceStatus)) {
        query.status = status;
      }
    } else {
      // By default, show live and scheduled spaces (not ended)
      query.status = { $in: [SpaceStatus.LIVE, SpaceStatus.SCHEDULED] };
    }

    // Filter by host
    if (host && typeof host === 'string') {
      query.host = host;
    }

    // Cursor-based pagination
    if (cursor && typeof cursor === 'string') {
      query._id = { $lt: cursor };
    }

    const limitNum = Math.min(Math.max(parseInt(limit as string, 10) || 20, 1), 100);

    const spaces = await Space.find(query)
      .sort({ createdAt: -1 })
      .limit(limitNum + 1)
      .lean();

    // Check if there are more results
    const hasMore = spaces.length > limitNum;
    const spacesToReturn = hasMore ? spaces.slice(0, limitNum) : spaces;
    const nextCursor = hasMore && spacesToReturn.length > 0
      ? spacesToReturn[spacesToReturn.length - 1]._id.toString()
      : undefined;

    res.json({
      spaces: spacesToReturn,
      hasMore,
      nextCursor
    });
  } catch (error) {
    logger.error('Error fetching spaces:', error);
    res.status(500).json({
      message: 'Error fetching spaces',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Get space details
 * GET /api/spaces/:id
 */
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const space = await Space.findById(id).lean();

    if (!space) {
      return res.status(404).json({ message: 'Space not found' });
    }

    res.json({ space });
  } catch (error) {
    logger.error('Error fetching space:', error);
    res.status(500).json({
      message: 'Error fetching space',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Start a space (host only)
 * POST /api/spaces/:id/start
 */
router.post('/:id/start', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const space = await Space.findById(id);

    if (!space) {
      return res.status(404).json({ message: 'Space not found' });
    }

    // Only host can start the space
    if (space.host !== userId) {
      return res.status(403).json({ message: 'Only the host can start the space' });
    }

    // Can only start scheduled spaces
    if (space.status !== SpaceStatus.SCHEDULED) {
      return res.status(400).json({
        message: `Cannot start space with status: ${space.status}`
      });
    }

    // Update space status
    space.status = SpaceStatus.LIVE;
    space.startedAt = new Date();
    await space.save();

    logger.info(`Space started: ${space._id}`);

    // Emit socket event to notify participants
    const io = (global as any).io;
    if (io) {
      io.to(`space:${id}`).emit('space:started', {
        spaceId: id,
        startedAt: space.startedAt,
        timestamp: new Date().toISOString()
      });
    }

    res.json({
      message: 'Space started successfully',
      space
    });
  } catch (error) {
    logger.error('Error starting space:', error);
    res.status(500).json({
      message: 'Error starting space',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * End a space (host only)
 * POST /api/spaces/:id/end
 */
router.post('/:id/end', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const space = await Space.findById(id);

    if (!space) {
      return res.status(404).json({ message: 'Space not found' });
    }

    // Only host can end the space
    if (space.host !== userId) {
      return res.status(403).json({ message: 'Only the host can end the space' });
    }

    // Can only end live spaces
    if (space.status !== SpaceStatus.LIVE) {
      return res.status(400).json({
        message: `Cannot end space with status: ${space.status}`
      });
    }

    // Update space status
    space.status = SpaceStatus.ENDED;
    space.endedAt = new Date();
    await space.save();

    logger.info(`Space ended: ${space._id}`);

    // Emit socket event to notify all participants
    const io = (global as any).io;
    if (io) {
      io.to(`space:${id}`).emit('space:ended', {
        spaceId: id,
        endedAt: space.endedAt,
        timestamp: new Date().toISOString()
      });
    }

    res.json({
      message: 'Space ended successfully',
      space
    });
  } catch (error) {
    logger.error('Error ending space:', error);
    res.status(500).json({
      message: 'Error ending space',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Join a space as listener
 * POST /api/spaces/:id/join
 */
router.post('/:id/join', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const space = await Space.findById(id);

    if (!space) {
      return res.status(404).json({ message: 'Space not found' });
    }

    // Can only join live spaces
    if (space.status !== SpaceStatus.LIVE) {
      return res.status(400).json({
        message: 'Space is not currently live'
      });
    }

    // Check if already a participant
    if (space.participants.includes(userId)) {
      return res.json({
        message: 'Already joined',
        space
      });
    }

    // Check capacity
    if (space.participants.length >= space.maxParticipants) {
      return res.status(403).json({
        message: 'Space is at maximum capacity'
      });
    }

    // Add to participants
    space.participants.push(userId);
    space.stats.totalJoined += 1;

    // Update peak listeners if necessary
    if (space.participants.length > space.stats.peakListeners) {
      space.stats.peakListeners = space.participants.length;
    }

    await space.save();

    logger.debug(`User ${userId} joined space ${id}`);

    // Emit socket event
    const io = (global as any).io;
    if (io) {
      io.to(`space:${id}`).emit('space:participant:joined', {
        spaceId: id,
        userId,
        participantCount: space.participants.length,
        timestamp: new Date().toISOString()
      });
    }

    res.json({
      message: 'Joined space successfully',
      space
    });
  } catch (error) {
    logger.error('Error joining space:', error);
    res.status(500).json({
      message: 'Error joining space',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Leave a space
 * POST /api/spaces/:id/leave
 */
router.post('/:id/leave', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const space = await Space.findById(id);

    if (!space) {
      return res.status(404).json({ message: 'Space not found' });
    }

    // Remove from participants
    space.participants = space.participants.filter(p => p !== userId);

    // If leaving as speaker, remove from speakers too
    if (space.speakers.includes(userId) && space.host !== userId) {
      space.speakers = space.speakers.filter(s => s !== userId);
    }

    await space.save();

    logger.debug(`User ${userId} left space ${id}`);

    // Emit socket event
    const io = (global as any).io;
    if (io) {
      io.to(`space:${id}`).emit('space:participant:left', {
        spaceId: id,
        userId,
        participantCount: space.participants.length,
        timestamp: new Date().toISOString()
      });
    }

    res.json({
      message: 'Left space successfully'
    });
  } catch (error) {
    logger.error('Error leaving space:', error);
    res.status(500).json({
      message: 'Error leaving space',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Add speaker (host only)
 * POST /api/spaces/:id/speakers
 */
router.post('/:id/speakers', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    const { userId: speakerId } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!speakerId) {
      return res.status(400).json({ message: 'userId is required' });
    }

    const space = await Space.findById(id);

    if (!space) {
      return res.status(404).json({ message: 'Space not found' });
    }

    // Only host can add speakers
    if (space.host !== userId) {
      return res.status(403).json({ message: 'Only the host can add speakers' });
    }

    // Check if already a speaker
    if (space.speakers.includes(speakerId)) {
      return res.json({
        message: 'User is already a speaker',
        space
      });
    }

    // Add to speakers
    space.speakers.push(speakerId);
    await space.save();

    logger.info(`User ${speakerId} added as speaker in space ${id} by ${userId}`);

    // Emit socket event
    const io = (global as any).io;
    if (io) {
      io.to(`space:${id}`).emit('space:speaker:added', {
        spaceId: id,
        speakerId,
        timestamp: new Date().toISOString()
      });
    }

    res.json({
      message: 'Speaker added successfully',
      space
    });
  } catch (error) {
    logger.error('Error adding speaker:', error);
    res.status(500).json({
      message: 'Error adding speaker',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Remove speaker (host only)
 * DELETE /api/spaces/:id/speakers/:userId
 */
router.delete('/:id/speakers/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const currentUserId = req.user?.id;
    const { id, userId: speakerId } = req.params;

    if (!currentUserId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const space = await Space.findById(id);

    if (!space) {
      return res.status(404).json({ message: 'Space not found' });
    }

    // Only host can remove speakers
    if (space.host !== currentUserId) {
      return res.status(403).json({ message: 'Only the host can remove speakers' });
    }

    // Cannot remove host as speaker
    if (speakerId === space.host) {
      return res.status(400).json({ message: 'Cannot remove host as speaker' });
    }

    // Remove from speakers
    const originalLength = space.speakers.length;
    space.speakers = space.speakers.filter(s => s !== speakerId);

    if (space.speakers.length === originalLength) {
      return res.status(404).json({ message: 'User is not a speaker' });
    }

    await space.save();

    logger.info(`User ${speakerId} removed as speaker from space ${id} by ${currentUserId}`);

    // Emit socket event
    const io = (global as any).io;
    if (io) {
      io.to(`space:${id}`).emit('space:speaker:removed', {
        spaceId: id,
        speakerId,
        timestamp: new Date().toISOString()
      });
    }

    res.json({
      message: 'Speaker removed successfully',
      space
    });
  } catch (error) {
    logger.error('Error removing speaker:', error);
    res.status(500).json({
      message: 'Error removing speaker',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
