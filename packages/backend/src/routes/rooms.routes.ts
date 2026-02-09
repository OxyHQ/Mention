import { Router, Response } from 'express';
import Room, { RoomStatus, RoomType, OwnerType, BroadcastKind, SpeakerPermission } from '../models/Room';
import House, { HouseMemberRole } from '../models/House';
import { AuthRequest } from '../types/auth';
import { logger } from '../utils/logger';
import {
  generateRoomToken,
  generateBroadcastToken,
  createLiveKitRoomForRoom,
  deleteLiveKitRoomForRoom,
  createRoomUrlIngress,
  createRoomRtmpIngress,
  deleteIngress,
} from '../utils/livekit';

const router = Router();

/**
 * Create a room
 * POST /api/rooms
 */
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const {
      title,
      description,
      scheduledStart,
      maxParticipants,
      topic,
      tags,
      speakerPermission,
      type,
      ownerType,
      broadcastKind,
      houseId,
    } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      return res.status(400).json({ message: 'Title is required' });
    }

    // Validate type
    const roomType: RoomType = type && Object.values(RoomType).includes(type)
      ? type
      : RoomType.TALK;

    // Validate ownerType
    const roomOwnerType: OwnerType = ownerType && Object.values(OwnerType).includes(ownerType)
      ? ownerType
      : OwnerType.PROFILE;

    // Reject agora-owned rooms from this endpoint (admin-only)
    if (roomOwnerType === OwnerType.AGORA) {
      return res.status(403).json({ message: 'Agora-owned rooms can only be created by admins' });
    }

    // Validate house ownership permission
    if (roomOwnerType === OwnerType.HOUSE) {
      if (!houseId || typeof houseId !== 'string') {
        return res.status(400).json({ message: 'houseId is required when ownerType is house' });
      }

      const house = await House.findById(houseId);
      if (!house) {
        return res.status(404).json({ message: 'House not found' });
      }

      // User must have HOST role or higher in the house
      if (!house.hasRole(userId, HouseMemberRole.HOST)) {
        return res.status(403).json({ message: 'You must be a host or higher in this house to create rooms' });
      }
    }

    // Validate scheduledStart if provided
    let scheduledStartDate: Date | undefined;
    if (scheduledStart) {
      scheduledStartDate = new Date(scheduledStart);
      if (isNaN(scheduledStartDate.getTime())) {
        return res.status(400).json({ message: 'Invalid scheduledStart date' });
      }
    }

    // For broadcast rooms, speakers array should only contain the host
    // and speakerPermission is always 'invited'
    const isBroadcast = roomType === RoomType.BROADCAST;

    const roomSpeakerPermission = isBroadcast
      ? SpeakerPermission.INVITED
      : (speakerPermission && Object.values(SpeakerPermission).includes(speakerPermission)
        ? speakerPermission
        : SpeakerPermission.INVITED);

    // Resolve broadcastKind for broadcast rooms
    let resolvedBroadcastKind: BroadcastKind | undefined;
    if (isBroadcast) {
      resolvedBroadcastKind = broadcastKind && Object.values(BroadcastKind).includes(broadcastKind)
        ? broadcastKind
        : BroadcastKind.USER;
    }

    // Create room
    const room = new Room({
      title: title.trim(),
      description: description ? String(description).trim() : undefined,
      host: userId,
      type: roomType,
      ownerType: roomOwnerType,
      broadcastKind: resolvedBroadcastKind,
      houseId: roomOwnerType === OwnerType.HOUSE ? houseId : undefined,
      status: RoomStatus.SCHEDULED,
      participants: [],
      speakers: [userId], // Host is automatically a speaker
      maxParticipants: maxParticipants && typeof maxParticipants === 'number'
        ? Math.min(Math.max(maxParticipants, 1), 10000)
        : 100,
      scheduledStart: scheduledStartDate,
      topic: topic ? String(topic).trim() : undefined,
      tags: Array.isArray(tags) ? tags.map((t: unknown) => String(t).trim()).filter(Boolean) : [],
      speakerPermission: roomSpeakerPermission,
      stats: {
        peakListeners: 0,
        totalJoined: 0,
      },
    });

    await room.save();

    logger.info(`Room created: ${room._id} by ${userId} (type=${roomType}, ownerType=${roomOwnerType})`);

    res.status(201).json({
      message: 'Room created successfully',
      room,
    });
  } catch (error) {
    logger.error('Error creating room:', { userId: req.user?.id, error });
    res.status(500).json({
      message: 'Error creating room',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * List active/scheduled rooms
 * GET /api/rooms
 * Query params: status, host, type, ownerType, houseId, limit, cursor
 */
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { status, host, type, ownerType, houseId, limit = '20', cursor } = req.query;

    const query: Record<string, unknown> = {
      archived: { $ne: true },
    };

    // Filter by status
    if (status && typeof status === 'string') {
      const validStatuses = Object.values(RoomStatus);
      if (validStatuses.includes(status as RoomStatus)) {
        query.status = status;
      }
    } else {
      // By default, show live and scheduled rooms (not ended)
      query.status = { $in: [RoomStatus.LIVE, RoomStatus.SCHEDULED] };
    }

    // Filter by host
    if (host && typeof host === 'string') {
      query.host = host;
    }

    // Filter by type
    if (type && typeof type === 'string') {
      const validTypes = Object.values(RoomType);
      if (validTypes.includes(type as RoomType)) {
        query.type = type;
      }
    }

    // Filter by ownerType
    if (ownerType && typeof ownerType === 'string') {
      const validOwnerTypes = Object.values(OwnerType);
      if (validOwnerTypes.includes(ownerType as OwnerType)) {
        query.ownerType = ownerType;
      }
    }

    // Filter by houseId
    if (houseId && typeof houseId === 'string') {
      query.houseId = houseId;
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

    // Check if there are more results
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
    logger.error('Error fetching rooms:', { userId: req.user?.id, error, query: req.query });
    res.status(500).json({
      message: 'Error fetching rooms',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get room details
 * GET /api/rooms/:id
 */
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const room = await Room.findById(id).lean();

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    // Strip internal stream fields from non-host users
    if (req.user?.id !== room.host) {
      delete room.activeStreamUrl;
      delete room.activeIngressId;
      delete room.rtmpUrl;
      delete room.rtmpStreamKey;
    }

    res.json({ room });
  } catch (error) {
    logger.error('Error fetching room:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error fetching room',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Start a room (host only)
 * POST /api/rooms/:id/start
 */
router.post('/:id/start', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id);

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    // Only host can start the room
    if (room.host !== userId) {
      return res.status(403).json({ message: 'Only the host can start the room' });
    }

    // Can only start scheduled rooms
    if (room.status !== RoomStatus.SCHEDULED) {
      return res.status(400).json({
        message: `Cannot start room with status: ${room.status}`,
      });
    }

    // For broadcast rooms, ensure speakers array only contains the host
    if (room.type === RoomType.BROADCAST) {
      room.speakers = [userId];
      room.speakerPermission = SpeakerPermission.INVITED;
    }

    // Create LiveKit room before going live
    try {
      await createLiveKitRoomForRoom(String(id), room.maxParticipants);
    } catch (lkErr) {
      logger.error(`Failed to create LiveKit room for room ${id}, starting anyway:`, lkErr);
    }

    // Update room status
    room.status = RoomStatus.LIVE;
    room.startedAt = new Date();
    await room.save();

    logger.info(`Room started: ${room._id} (type=${room.type})`);

    // Emit socket event on /spaces namespace (backward compat)
    const io = (global as any).io;
    if (io) {
      io.of('/spaces').to(`space:${id}`).emit('space:started', {
        spaceId: id,
        roomId: id,
        startedAt: room.startedAt,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({
      message: 'Room started successfully',
      room,
    });
  } catch (error) {
    logger.error('Error starting room:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error starting room',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * End a room (host only)
 * POST /api/rooms/:id/end
 */
router.post('/:id/end', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id);

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    // Only host can end the room
    if (room.host !== userId) {
      return res.status(403).json({ message: 'Only the host can end the room' });
    }

    // Can only end live rooms
    if (room.status !== RoomStatus.LIVE) {
      return res.status(400).json({
        message: `Cannot end room with status: ${room.status}`,
      });
    }

    // Update room status
    room.status = RoomStatus.ENDED;
    room.endedAt = new Date();

    // Clean up active ingress if any
    if (room.activeIngressId) {
      deleteIngress(room.activeIngressId).catch((err) => {
        logger.error(`Failed to delete ingress for room ${id}:`, err);
      });
      room.activeIngressId = undefined;
      room.activeStreamUrl = undefined;
      room.streamTitle = undefined;
      room.streamImage = undefined;
      room.streamDescription = undefined;
      room.rtmpUrl = undefined;
      room.rtmpStreamKey = undefined;
    }

    await room.save();

    // Clean up LiveKit room
    deleteLiveKitRoomForRoom(String(id)).catch((err) => {
      logger.error(`Failed to delete LiveKit room for room ${id}:`, err);
    });

    logger.info(`Room ended: ${room._id}`);

    // Emit socket event on /spaces namespace (backward compat)
    const io = (global as any).io;
    if (io) {
      io.of('/spaces').to(`space:${id}`).emit('space:ended', {
        spaceId: id,
        roomId: id,
        endedAt: room.endedAt,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({
      message: 'Room ended successfully',
      room,
    });
  } catch (error) {
    logger.error('Error ending room:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error ending room',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Stop a live session (host only) — returns room to scheduled status so it can
 * be reused.  Cleans up LiveKit room and any active ingress, but does NOT
 * permanently end the room.
 * POST /api/rooms/:id/stop
 */
router.post('/:id/stop', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id);

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (room.host !== userId) {
      return res.status(403).json({ message: 'Only the host can stop the room' });
    }

    if (room.status !== RoomStatus.LIVE) {
      return res.status(400).json({
        message: `Cannot stop room with status: ${room.status}`,
      });
    }

    // Reset to scheduled so the host can go live again later
    room.status = RoomStatus.SCHEDULED;
    room.startedAt = undefined;

    // Clean up active ingress if any
    if (room.activeIngressId) {
      deleteIngress(room.activeIngressId).catch((err) => {
        logger.error(`Failed to delete ingress for room ${id}:`, err);
      });
      room.activeIngressId = undefined;
      room.activeStreamUrl = undefined;
      room.streamTitle = undefined;
      room.streamImage = undefined;
      room.streamDescription = undefined;
      room.rtmpUrl = undefined;
      room.rtmpStreamKey = undefined;
    }

    await room.save();

    // Clean up LiveKit room
    deleteLiveKitRoomForRoom(String(id)).catch((err) => {
      logger.error(`Failed to delete LiveKit room for room ${id}:`, err);
    });

    logger.info(`Room stopped (back to scheduled): ${room._id}`);

    // Emit socket event so participants know the session ended
    const io = (global as any).io;
    if (io) {
      io.of('/spaces').to(`space:${id}`).emit('space:ended', {
        spaceId: id,
        roomId: id,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({
      message: 'Live session stopped',
      room,
    });
  } catch (error) {
    logger.error('Error stopping room:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error stopping room',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Join a room as listener
 * POST /api/rooms/:id/join
 */
router.post('/:id/join', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id);

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    // Can only join live rooms
    if (room.status !== RoomStatus.LIVE) {
      return res.status(400).json({
        message: 'Room is not currently live',
      });
    }

    // Check if already a participant
    if (room.participants.includes(userId)) {
      return res.json({
        message: 'Already joined',
        room,
      });
    }

    // Check capacity
    if (room.participants.length >= room.maxParticipants) {
      return res.status(403).json({
        message: 'Room is at maximum capacity',
      });
    }

    // Add to participants
    room.participants.push(userId);
    room.stats.totalJoined += 1;

    // Update peak listeners if necessary
    if (room.participants.length > room.stats.peakListeners) {
      room.stats.peakListeners = room.participants.length;
    }

    await room.save();

    logger.debug(`User ${userId} joined room ${id}`);

    // Emit socket event on /spaces namespace
    const io = (global as any).io;
    if (io) {
      io.of('/spaces').to(`space:${id}`).emit('space:participant:joined', {
        spaceId: id,
        roomId: id,
        userId,
        participantCount: room.participants.length,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({
      message: 'Joined room successfully',
      room,
    });
  } catch (error) {
    logger.error('Error joining room:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error joining room',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Leave a room
 * POST /api/rooms/:id/leave
 */
router.post('/:id/leave', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id);

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    // Remove from participants
    room.participants = room.participants.filter(p => p !== userId);

    // If leaving as speaker, remove from speakers too (except host)
    if (room.speakers.includes(userId) && room.host !== userId) {
      room.speakers = room.speakers.filter(s => s !== userId);
    }

    await room.save();

    logger.debug(`User ${userId} left room ${id}`);

    // Emit socket event
    const io = (global as any).io;
    if (io) {
      io.of('/spaces').to(`space:${id}`).emit('space:participant:left', {
        spaceId: id,
        roomId: id,
        userId,
        participantCount: room.participants.length,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({
      message: 'Left room successfully',
    });
  } catch (error) {
    logger.error('Error leaving room:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error leaving room',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Add speaker (host only)
 * POST /api/rooms/:id/speakers
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

    const room = await Room.findById(id);

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    // Only host can add speakers
    if (room.host !== userId) {
      return res.status(403).json({ message: 'Only the host can add speakers' });
    }

    // Broadcast rooms do not allow adding speakers
    if (room.type === RoomType.BROADCAST) {
      return res.status(400).json({ message: 'Cannot add speakers to a broadcast room' });
    }

    // Check if already a speaker
    if (room.speakers.includes(speakerId)) {
      return res.json({
        message: 'User is already a speaker',
        room,
      });
    }

    // Add to speakers
    room.speakers.push(speakerId);
    await room.save();

    logger.info(`User ${speakerId} added as speaker in room ${id} by ${userId}`);

    // Emit socket event
    const io = (global as any).io;
    if (io) {
      io.of('/spaces').to(`space:${id}`).emit('space:speaker:added', {
        spaceId: id,
        roomId: id,
        speakerId,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({
      message: 'Speaker added successfully',
      room,
    });
  } catch (error) {
    logger.error('Error adding speaker:', { userId: req.user?.id, roomId: req.params.id, speakerId: req.body.userId, error });
    res.status(500).json({
      message: 'Error adding speaker',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Remove speaker (host only)
 * DELETE /api/rooms/:id/speakers/:userId
 */
router.delete('/:id/speakers/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const currentUserId = req.user?.id;
    const { id, userId: speakerId } = req.params;

    if (!currentUserId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id);

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    // Only host can remove speakers
    if (room.host !== currentUserId) {
      return res.status(403).json({ message: 'Only the host can remove speakers' });
    }

    // Cannot remove host as speaker
    if (speakerId === room.host) {
      return res.status(400).json({ message: 'Cannot remove host as speaker' });
    }

    // Remove from speakers
    const originalLength = room.speakers.length;
    room.speakers = room.speakers.filter(s => s !== speakerId);

    if (room.speakers.length === originalLength) {
      return res.status(404).json({ message: 'User is not a speaker' });
    }

    await room.save();

    logger.info(`User ${speakerId} removed as speaker from room ${id} by ${currentUserId}`);

    // Emit socket event
    const io = (global as any).io;
    if (io) {
      io.of('/spaces').to(`space:${id}`).emit('space:speaker:removed', {
        spaceId: id,
        roomId: id,
        speakerId,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({
      message: 'Speaker removed successfully',
      room,
    });
  } catch (error) {
    logger.error('Error removing speaker:', { userId: req.user?.id, roomId: req.params.id, speakerId: req.params.userId, error });
    res.status(500).json({
      message: 'Error removing speaker',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get a LiveKit token for joining a room's audio room
 * POST /api/rooms/:id/token
 *
 * For broadcast rooms, everyone except the host gets a listen-only token.
 */
router.post('/:id/token', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id).lean();
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (room.status !== RoomStatus.LIVE) {
      return res.status(400).json({ message: 'Room is not live' });
    }

    let token: string;

    if (room.type === RoomType.BROADCAST) {
      // Broadcast rooms: only host gets publish permissions
      const isHost = room.host === userId;
      token = await generateBroadcastToken(String(id), userId, isHost);
    } else {
      // Talk / Stage rooms: determine role normally
      let role: 'host' | 'speaker' | 'listener' = 'listener';
      if (room.host === userId) {
        role = 'host';
      } else if (room.speakers.includes(userId)) {
        role = 'speaker';
      }
      token = await generateRoomToken(String(id), userId, role);
    }

    res.json({
      token,
      url: process.env.LIVEKIT_URL || '',
    });
  } catch (error) {
    logger.error('Error generating room token:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error generating token',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Start external live stream (host only)
 * POST /api/rooms/:id/stream
 * Body: { url: string, title?, image?, description? }
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

    const room = await Room.findById(id);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (room.host !== userId) {
      return res.status(403).json({ message: 'Only the host can add a live stream' });
    }

    if (room.status !== RoomStatus.LIVE) {
      return res.status(400).json({ message: 'Room must be live to add a stream' });
    }

    // If there's already an active ingress, delete it first
    if (room.activeIngressId) {
      await deleteIngress(room.activeIngressId);
    }

    // Create the URL ingress
    const ingress = await createRoomUrlIngress(String(id), trimmedUrl);

    // Persist ingress info + metadata (clear RTMP fields if switching modes)
    room.activeIngressId = ingress.ingressId;
    room.activeStreamUrl = trimmedUrl;
    room.rtmpUrl = undefined;
    room.rtmpStreamKey = undefined;
    room.streamTitle = title ? String(title).trim() : undefined;
    room.streamImage = image ? String(image).trim() : undefined;
    room.streamDescription = description ? String(description).trim() : undefined;
    await room.save();

    logger.info(`Live stream started in room ${id}: ${trimmedUrl}`);

    // Notify participants via socket (no URL -- only metadata)
    const io = (global as any).io;
    if (io) {
      io.of('/spaces').to(`space:${id}`).emit('space:stream:started', {
        spaceId: id,
        roomId: id,
        title: room.streamTitle || null,
        image: room.streamImage || null,
        description: room.streamDescription || null,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({
      message: 'Stream started successfully',
      ingressId: ingress.ingressId,
      url: trimmedUrl,
    });
  } catch (error) {
    logger.error('Error starting stream:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error starting stream',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Stop external live stream (host only)
 * DELETE /api/rooms/:id/stream
 */
router.delete('/:id/stream', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (room.host !== userId) {
      return res.status(403).json({ message: 'Only the host can remove the stream' });
    }

    if (!room.activeIngressId) {
      return res.status(400).json({ message: 'No active stream' });
    }

    // Delete the ingress from LiveKit
    await deleteIngress(room.activeIngressId);

    // Clear all stream fields
    room.activeIngressId = undefined;
    room.activeStreamUrl = undefined;
    room.streamTitle = undefined;
    room.streamImage = undefined;
    room.streamDescription = undefined;
    room.rtmpUrl = undefined;
    room.rtmpStreamKey = undefined;
    await room.save();

    logger.info(`Live stream stopped in room ${id}`);

    // Notify participants via socket
    const io = (global as any).io;
    if (io) {
      io.of('/spaces').to(`space:${id}`).emit('space:stream:stopped', {
        spaceId: id,
        roomId: id,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({ message: 'Stream stopped successfully' });
  } catch (error) {
    logger.error('Error stopping stream:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error stopping stream',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Update stream metadata (host only)
 * PATCH /api/rooms/:id/stream
 * Body: { title?, image?, description? }
 */
router.patch('/:id/stream', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    const { title, image, description } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (room.host !== userId) {
      return res.status(403).json({ message: 'Only the host can update stream info' });
    }

    if (!room.activeIngressId) {
      return res.status(400).json({ message: 'No active stream to update' });
    }

    // Update metadata fields
    if (title !== undefined) room.streamTitle = title ? String(title).trim() : undefined;
    if (image !== undefined) room.streamImage = image ? String(image).trim() : undefined;
    if (description !== undefined) room.streamDescription = description ? String(description).trim() : undefined;
    await room.save();

    logger.info(`Stream metadata updated for room ${id}`);

    // Notify participants via socket with updated metadata
    const io = (global as any).io;
    if (io) {
      io.of('/spaces').to(`space:${id}`).emit('space:stream:started', {
        spaceId: id,
        roomId: id,
        title: room.streamTitle || null,
        image: room.streamImage || null,
        description: room.streamDescription || null,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({ message: 'Stream info updated' });
  } catch (error) {
    logger.error('Error updating stream metadata:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error updating stream info',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Generate RTMP stream key (host only)
 * POST /api/rooms/:id/stream/rtmp
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

    const room = await Room.findById(id);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (room.host !== userId) {
      return res.status(403).json({ message: 'Only the host can configure streaming' });
    }

    if (room.status !== RoomStatus.LIVE) {
      return res.status(400).json({ message: 'Room must be live to configure streaming' });
    }

    // If there's already an active ingress, delete it first
    if (room.activeIngressId) {
      await deleteIngress(room.activeIngressId);
    }

    // Create the RTMP ingress
    const ingress = await createRoomRtmpIngress(String(id));

    // LiveKit may return an empty url if the RTMP service doesn't have a
    // public URL configured.  Derive a fallback from LIVEKIT_URL.
    let rtmpUrl = ingress.url || '';
    if (!rtmpUrl) {
      const host = (process.env.LIVEKIT_URL || '')
        .replace(/^wss?:\/\//, '')
        .replace(/\/+$/, '');
      if (host) rtmpUrl = `rtmp://${host}:1935/live`;
    }

    // Persist ingress info + metadata (clear URL mode fields)
    room.activeIngressId = ingress.ingressId;
    room.activeStreamUrl = undefined;
    room.rtmpUrl = rtmpUrl;
    room.rtmpStreamKey = ingress.streamKey;
    room.streamTitle = title ? String(title).trim() : undefined;
    room.streamImage = image ? String(image).trim() : undefined;
    room.streamDescription = description ? String(description).trim() : undefined;
    await room.save();

    logger.info(`RTMP ingress created for room ${id}: ${ingress.ingressId}`);

    // Notify participants via socket (metadata only -- no credentials)
    const io = (global as any).io;
    if (io) {
      io.of('/spaces').to(`space:${id}`).emit('space:stream:started', {
        spaceId: id,
        roomId: id,
        title: room.streamTitle || null,
        image: room.streamImage || null,
        description: room.streamDescription || null,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({
      message: 'RTMP stream key generated',
      rtmpUrl,
      streamKey: ingress.streamKey,
    });
  } catch (error) {
    logger.error('Error generating RTMP key:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error generating stream key',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Delete a room (host only)
 * DELETE /api/rooms/:id
 */
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id);

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    // Only host can delete the room
    if (room.host !== userId) {
      return res.status(403).json({ message: 'Only the host can delete the room' });
    }

    // Cannot delete a live room
    if (room.status === RoomStatus.LIVE) {
      return res.status(400).json({ message: 'Cannot delete a live room. End it first.' });
    }

    await Room.findByIdAndDelete(id);

    logger.info(`Room deleted: ${id} by ${userId}`);

    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting room:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error deleting room',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Archive/Unarchive a room (host only)
 * PATCH /api/rooms/:id/archive
 */
router.patch('/:id/archive', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id);

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    // Only host can archive the room
    if (room.host !== userId) {
      return res.status(403).json({ message: 'Only the host can archive the room' });
    }

    // Cannot archive a live room
    if (room.status === RoomStatus.LIVE) {
      return res.status(400).json({ message: 'Cannot archive a live room. End it first.' });
    }

    // Toggle archived status
    room.archived = !room.archived;
    await room.save();

    logger.info(`Room ${room.archived ? 'archived' : 'unarchived'}: ${id} by ${userId}`);

    res.json({ success: true, archived: room.archived });
  } catch (error) {
    logger.error('Error archiving room:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error archiving room',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
