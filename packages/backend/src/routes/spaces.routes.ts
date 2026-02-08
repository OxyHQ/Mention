import { Router, Response } from 'express';
import Space, { SpaceStatus, SpeakerPermission } from '../models/Space';
import { AuthRequest } from '../types/auth';
import { logger } from '../utils/logger';
import { generateSpaceToken, createLiveKitRoom, deleteLiveKitRoom, createUrlIngress, createRtmpIngress, deleteIngress } from '../utils/livekit';

const router = Router();

/**
 * Create a space
 * POST /api/spaces
 */
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { title, description, scheduledStart, maxParticipants, topic, tags, speakerPermission } = req.body;

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
      speakerPermission: speakerPermission && Object.values(SpeakerPermission).includes(speakerPermission)
        ? speakerPermission
        : SpeakerPermission.INVITED,
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
    logger.error('Error creating space:', { userId: req.user?.id, error });
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
    logger.error('Error fetching spaces:', { userId: req.user?.id, error, query: req.query });
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

    // Strip internal stream fields from non-host users
    if (req.user?.id !== space.host) {
      delete space.activeStreamUrl;
      delete space.activeIngressId;
      delete space.rtmpUrl;
      delete space.rtmpStreamKey;
    }

    res.json({ space });
  } catch (error) {
    logger.error('Error fetching space:', { userId: req.user?.id, spaceId: req.params.id, error });
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

    // Create LiveKit room before going live
    try {
      await createLiveKitRoom(String(id), space.maxParticipants);
    } catch (lkErr) {
      logger.error(`Failed to create LiveKit room for space ${id}, starting anyway:`, lkErr);
    }

    // Update space status
    space.status = SpaceStatus.LIVE;
    space.startedAt = new Date();
    await space.save();

    logger.info(`Space started: ${space._id}`);

    // Emit socket event on /spaces namespace
    const io = (global as any).io;
    if (io) {
      io.of('/spaces').to(`space:${id}`).emit('space:started', {
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
    logger.error('Error starting space:', { userId: req.user?.id, spaceId: req.params.id, error });
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

    // Clean up active ingress if any
    if (space.activeIngressId) {
      deleteIngress(space.activeIngressId).catch((err) => {
        logger.error(`Failed to delete ingress for space ${id}:`, err);
      });
      space.activeIngressId = undefined;
      space.activeStreamUrl = undefined;
      space.streamTitle = undefined;
      space.streamImage = undefined;
      space.streamDescription = undefined;
      space.rtmpUrl = undefined;
      space.rtmpStreamKey = undefined;
    }

    await space.save();

    // Clean up LiveKit room
    deleteLiveKitRoom(String(id)).catch((err) => {
      logger.error(`Failed to delete LiveKit room for space ${id}:`, err);
    });

    logger.info(`Space ended: ${space._id}`);

    // Emit socket event on /spaces namespace
    const io = (global as any).io;
    if (io) {
      io.of('/spaces').to(`space:${id}`).emit('space:ended', {
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
    logger.error('Error ending space:', { userId: req.user?.id, spaceId: req.params.id, error });
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

    // Emit socket event on /spaces namespace
    const io = (global as any).io;
    if (io) {
      io.of('/spaces').to(`space:${id}`).emit('space:participant:joined', {
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
    logger.error('Error joining space:', { userId: req.user?.id, spaceId: req.params.id, error });
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
      io.of('/spaces').to(`space:${id}`).emit('space:participant:left', {
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
    logger.error('Error leaving space:', { userId: req.user?.id, spaceId: req.params.id, error });
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
      io.of('/spaces').to(`space:${id}`).emit('space:speaker:added', {
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
    logger.error('Error adding speaker:', { userId: req.user?.id, spaceId: req.params.id, speakerId: req.body.userId, error });
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
      io.of('/spaces').to(`space:${id}`).emit('space:speaker:removed', {
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
    logger.error('Error removing speaker:', { userId: req.user?.id, spaceId: req.params.id, speakerId: req.params.userId, error });
    res.status(500).json({
      message: 'Error removing speaker',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Get a LiveKit token for joining a space's audio room
 * POST /api/spaces/:id/token
 */
router.post('/:id/token', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const space = await Space.findById(id).lean();
    if (!space) {
      return res.status(404).json({ message: 'Space not found' });
    }

    if (space.status !== SpaceStatus.LIVE) {
      return res.status(400).json({ message: 'Space is not live' });
    }

    // Determine role
    let role: 'host' | 'speaker' | 'listener' = 'listener';
    if (space.host === userId) {
      role = 'host';
    } else if (space.speakers.includes(userId)) {
      role = 'speaker';
    }

    const token = await generateSpaceToken(String(id), userId, role);

    res.json({
      token,
      url: process.env.LIVEKIT_URL || '',
    });
  } catch (error) {
    logger.error('Error generating space token:', { userId: req.user?.id, spaceId: req.params.id, error });
    res.status(500).json({
      message: 'Error generating token',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Start external live stream (host only)
 * POST /api/spaces/:id/stream
 * Body: { url: string }
 */
router.post('/:id/stream', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    const { url, title, image, description } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ message: 'url is required' });
    }

    const trimmedUrl = url.trim();

    try {
      const parsed = new URL(trimmedUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return res.status(400).json({ message: 'Only http and https URLs are supported' });
      }
    } catch {
      return res.status(400).json({ message: 'Invalid URL format' });
    }

    const space = await Space.findById(id);
    if (!space) {
      return res.status(404).json({ message: 'Space not found' });
    }

    if (space.host !== userId) {
      return res.status(403).json({ message: 'Only the host can add a live stream' });
    }

    if (space.status !== SpaceStatus.LIVE) {
      return res.status(400).json({ message: 'Space must be live to add a stream' });
    }

    // If there's already an active ingress, delete it first
    if (space.activeIngressId) {
      await deleteIngress(space.activeIngressId);
    }

    // Create the URL ingress
    const ingress = await createUrlIngress(String(id), trimmedUrl);

    // Persist ingress info + metadata (clear RTMP fields if switching modes)
    space.activeIngressId = ingress.ingressId;
    space.activeStreamUrl = trimmedUrl;
    space.rtmpUrl = undefined;
    space.rtmpStreamKey = undefined;
    space.streamTitle = title ? String(title).trim() : undefined;
    space.streamImage = image ? String(image).trim() : undefined;
    space.streamDescription = description ? String(description).trim() : undefined;
    await space.save();

    logger.info(`Live stream started in space ${id}: ${trimmedUrl}`);

    // Notify participants via socket (no URL — only metadata)
    const io = (global as any).io;
    if (io) {
      io.of('/spaces').to(`space:${id}`).emit('space:stream:started', {
        spaceId: id,
        title: space.streamTitle || null,
        image: space.streamImage || null,
        description: space.streamDescription || null,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({
      message: 'Stream started successfully',
      ingressId: ingress.ingressId,
      url: trimmedUrl,
    });
  } catch (error) {
    logger.error('Error starting stream:', { userId: req.user?.id, spaceId: req.params.id, error });
    res.status(500).json({
      message: 'Error starting stream',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Stop external live stream (host only)
 * DELETE /api/spaces/:id/stream
 */
router.delete('/:id/stream', async (req: AuthRequest, res: Response) => {
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

    if (space.host !== userId) {
      return res.status(403).json({ message: 'Only the host can remove the stream' });
    }

    if (!space.activeIngressId) {
      return res.status(400).json({ message: 'No active stream' });
    }

    // Delete the ingress from LiveKit
    await deleteIngress(space.activeIngressId);

    // Clear all stream fields
    space.activeIngressId = undefined;
    space.activeStreamUrl = undefined;
    space.streamTitle = undefined;
    space.streamImage = undefined;
    space.streamDescription = undefined;
    space.rtmpUrl = undefined;
    space.rtmpStreamKey = undefined;
    await space.save();

    logger.info(`Live stream stopped in space ${id}`);

    // Notify participants via socket
    const io = (global as any).io;
    if (io) {
      io.of('/spaces').to(`space:${id}`).emit('space:stream:stopped', {
        spaceId: id,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({ message: 'Stream stopped successfully' });
  } catch (error) {
    logger.error('Error stopping stream:', { userId: req.user?.id, spaceId: req.params.id, error });
    res.status(500).json({
      message: 'Error stopping stream',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Generate RTMP stream key (host only)
 * POST /api/spaces/:id/stream/rtmp
 * Body: { title?, image?, description? }
 */
router.post('/:id/stream/rtmp', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    const { title, image, description } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const space = await Space.findById(id);
    if (!space) {
      return res.status(404).json({ message: 'Space not found' });
    }

    if (space.host !== userId) {
      return res.status(403).json({ message: 'Only the host can configure streaming' });
    }

    if (space.status !== SpaceStatus.LIVE) {
      return res.status(400).json({ message: 'Space must be live to configure streaming' });
    }

    // If there's already an active ingress, delete it first
    if (space.activeIngressId) {
      await deleteIngress(space.activeIngressId);
    }

    // Create the RTMP ingress
    const ingress = await createRtmpIngress(String(id));

    // Persist ingress info + metadata (clear URL mode fields)
    space.activeIngressId = ingress.ingressId;
    space.activeStreamUrl = undefined;
    space.rtmpUrl = ingress.url;
    space.rtmpStreamKey = ingress.streamKey;
    space.streamTitle = title ? String(title).trim() : undefined;
    space.streamImage = image ? String(image).trim() : undefined;
    space.streamDescription = description ? String(description).trim() : undefined;
    await space.save();

    logger.info(`RTMP ingress created for space ${id}: ${ingress.ingressId}`);

    // Notify participants via socket (metadata only — no credentials)
    const io = (global as any).io;
    if (io) {
      io.of('/spaces').to(`space:${id}`).emit('space:stream:started', {
        spaceId: id,
        title: space.streamTitle || null,
        image: space.streamImage || null,
        description: space.streamDescription || null,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({
      message: 'RTMP stream key generated',
      rtmpUrl: ingress.url,
      streamKey: ingress.streamKey,
    });
  } catch (error) {
    logger.error('Error generating RTMP key:', { userId: req.user?.id, spaceId: req.params.id, error });
    res.status(500).json({
      message: 'Error generating stream key',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
