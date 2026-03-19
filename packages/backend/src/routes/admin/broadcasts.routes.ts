import { Router, Response } from 'express';
import Room, {
  RoomStatus,
  RoomType,
  OwnerType,
  BroadcastKind,
  SpeakerPermission,
  IRoom,
} from '../../models/Room';
import { AuthRequest } from '../../types/auth';
import { logger } from '../../utils/logger';
import {
  createLiveKitRoomForRoom,
  deleteLiveKitRoomForRoom,
  createRoomUrlIngress,
  deleteIngress,
} from '../../utils/livekit';

const router = Router();

// ---------------------------------------------------------------------------
// Helper: Validate that a room is an Agora Broadcast
// ---------------------------------------------------------------------------
function isAgoraBroadcast(room: Pick<IRoom, 'ownerType' | 'type' | 'broadcastKind'>): boolean {
  return (
    room.ownerType === OwnerType.AGORA &&
    room.type === RoomType.BROADCAST &&
    room.broadcastKind === BroadcastKind.AGORA
  );
}

// ---------------------------------------------------------------------------
// POST / — Create an Agora Broadcast room
// ---------------------------------------------------------------------------
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const {
      title,
      description,
      streamUrl,
      tags,
      scheduledStart,
      streamTitle,
      streamImage,
      streamDescription,
    } = req.body;

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

    const room = new Room({
      title: title.trim(),
      description: description ? String(description).trim() : undefined,
      ownerType: OwnerType.AGORA,
      type: RoomType.BROADCAST,
      broadcastKind: BroadcastKind.AGORA,
      host: userId,
      createdByAdmin: userId,
      status: RoomStatus.SCHEDULED,
      speakerPermission: SpeakerPermission.INVITED,
      participants: [],
      speakers: [userId],
      scheduledStart: scheduledStartDate,
      tags: Array.isArray(tags) ? tags.map((t: unknown) => String(t).trim()).filter(Boolean) : [],
      streamTitle: streamTitle ? String(streamTitle).trim() : undefined,
      streamImage: streamImage ? String(streamImage).trim() : undefined,
      streamDescription: streamDescription ? String(streamDescription).trim() : undefined,
      stats: { peakListeners: 0, totalJoined: 0 },
    });

    // If a streamUrl is provided upfront, create the URL ingress immediately
    if (streamUrl && typeof streamUrl === 'string') {
      const trimmedUrl = streamUrl.trim();
      try {
        const parsed = new URL(trimmedUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return res.status(400).json({ message: 'Only http and https stream URLs are supported' });
        }
      } catch {
        return res.status(400).json({ message: 'Invalid streamUrl format' });
      }
      room.activeStreamUrl = trimmedUrl;
    }

    await room.save();

    // If streamUrl was provided, create the LiveKit URL ingress after saving
    if (room.activeStreamUrl) {
      try {
        const ingress = await createRoomUrlIngress(String(room._id), room.activeStreamUrl);
        room.activeIngressId = ingress.ingressId;
        await room.save();
      } catch (ingressErr) {
        logger.error(`Failed to create URL ingress for new Agora Broadcast ${room._id}:`, ingressErr);
        // Room is created, ingress can be retried later via PATCH or /stream
      }
    }

    logger.info(`[ADMIN] Agora Broadcast created: ${room._id} by admin ${userId}`);

    res.status(201).json({
      message: 'Agora Broadcast created successfully',
      room,
    });
  } catch (error) {
    logger.error('[ADMIN] Error creating Agora Broadcast:', { userId: req.user?.id, error });
    res.status(500).json({
      message: 'Error creating Agora Broadcast',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ---------------------------------------------------------------------------
// GET / — List all Agora Broadcast rooms (paginated, includes ended)
// ---------------------------------------------------------------------------
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { status, limit = '20', cursor } = req.query;

    const query: any = {
      ownerType: OwnerType.AGORA,
      type: RoomType.BROADCAST,
      broadcastKind: BroadcastKind.AGORA,
    };

    // Optional status filter
    if (status && typeof status === 'string') {
      const validStatuses = Object.values(RoomStatus);
      if (validStatuses.includes(status as RoomStatus)) {
        query.status = status;
      }
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
    const nextCursor =
      hasMore && roomsToReturn.length > 0
        ? roomsToReturn[roomsToReturn.length - 1]._id.toString()
        : undefined;

    res.json({
      rooms: roomsToReturn,
      hasMore,
      nextCursor,
    });
  } catch (error) {
    logger.error('[ADMIN] Error listing Agora Broadcasts:', { userId: req.user?.id, error });
    res.status(500).json({
      message: 'Error listing Agora Broadcasts',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ---------------------------------------------------------------------------
// GET /:id — Get Agora Broadcast details
// ---------------------------------------------------------------------------
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const room = await Room.findById(id).lean();

    if (!room) {
      return res.status(404).json({ message: 'Broadcast not found' });
    }

    if (!isAgoraBroadcast(room)) {
      return res.status(404).json({ message: 'Broadcast not found' });
    }

    res.json({ room });
  } catch (error) {
    logger.error('[ADMIN] Error fetching Agora Broadcast:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error fetching Agora Broadcast',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ---------------------------------------------------------------------------
// PATCH /:id — Update an Agora Broadcast
// ---------------------------------------------------------------------------
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id);
    if (!room) {
      return res.status(404).json({ message: 'Broadcast not found' });
    }

    if (!isAgoraBroadcast(room)) {
      return res.status(404).json({ message: 'Broadcast not found' });
    }

    const {
      title,
      description,
      tags,
      streamUrl,
      streamTitle,
      streamImage,
      streamDescription,
      scheduledStart,
    } = req.body;

    // Apply field updates
    if (title !== undefined) {
      if (typeof title !== 'string' || title.trim().length === 0) {
        return res.status(400).json({ message: 'Title cannot be empty' });
      }
      room.title = title.trim();
    }
    if (description !== undefined) {
      room.description = description ? String(description).trim() : undefined;
    }
    if (tags !== undefined) {
      room.tags = Array.isArray(tags) ? tags.map((t: unknown) => String(t).trim()).filter(Boolean) : [];
    }
    if (streamTitle !== undefined) {
      room.streamTitle = streamTitle ? String(streamTitle).trim() : undefined;
    }
    if (streamImage !== undefined) {
      room.streamImage = streamImage ? String(streamImage).trim() : undefined;
    }
    if (streamDescription !== undefined) {
      room.streamDescription = streamDescription ? String(streamDescription).trim() : undefined;
    }
    if (scheduledStart !== undefined) {
      if (scheduledStart === null) {
        room.scheduledStart = undefined;
      } else {
        const d = new Date(scheduledStart);
        if (isNaN(d.getTime())) {
          return res.status(400).json({ message: 'Invalid scheduledStart date' });
        }
        room.scheduledStart = d;
      }
    }

    // Handle streamUrl change — recreate ingress if room is live
    if (streamUrl !== undefined) {
      const newUrl = streamUrl ? String(streamUrl).trim() : null;

      if (newUrl) {
        try {
          const parsed = new URL(newUrl);
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            return res.status(400).json({ message: 'Only http and https stream URLs are supported' });
          }
        } catch {
          return res.status(400).json({ message: 'Invalid streamUrl format' });
        }
      }

      const urlChanged = newUrl !== (room.activeStreamUrl || null);

      if (urlChanged) {
        // Delete old ingress if one exists
        if (room.activeIngressId) {
          await deleteIngress(room.activeIngressId);
          room.activeIngressId = undefined;
        }

        if (newUrl) {
          room.activeStreamUrl = newUrl;

          // If room is live, create new ingress immediately
          if (room.status === RoomStatus.LIVE) {
            try {
              const ingress = await createRoomUrlIngress(String(room._id), newUrl);
              room.activeIngressId = ingress.ingressId;
            } catch (ingressErr) {
              logger.error(`[ADMIN] Failed to recreate ingress for broadcast ${id}:`, ingressErr);
            }
          }
        } else {
          room.activeStreamUrl = undefined;
        }
      }
    }

    await room.save();

    logger.info(`[ADMIN] Agora Broadcast updated: ${id} by admin ${userId}`);

    res.json({
      message: 'Agora Broadcast updated successfully',
      room,
    });
  } catch (error) {
    logger.error('[ADMIN] Error updating Agora Broadcast:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error updating Agora Broadcast',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ---------------------------------------------------------------------------
// DELETE /:id — Delete an Agora Broadcast (cleanup ingress if active)
// ---------------------------------------------------------------------------
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id);
    if (!room) {
      return res.status(404).json({ message: 'Broadcast not found' });
    }

    if (!isAgoraBroadcast(room)) {
      return res.status(404).json({ message: 'Broadcast not found' });
    }

    // Clean up active ingress
    if (room.activeIngressId) {
      deleteIngress(room.activeIngressId).catch((err) => {
        logger.error(`[ADMIN] Failed to delete ingress for broadcast ${id}:`, err);
      });
    }

    // Clean up LiveKit room if broadcast was live
    if (room.status === RoomStatus.LIVE) {
      deleteLiveKitRoomForRoom(String(id)).catch((err) => {
        logger.error(`[ADMIN] Failed to delete LiveKit room for broadcast ${id}:`, err);
      });
    }

    await Room.findByIdAndDelete(id);

    logger.info(`[ADMIN] Agora Broadcast deleted: ${id} by admin ${userId}`);

    // Emit socket event so clients know the broadcast is gone
    const io = (global as any).io;
    if (io) {
      io.of('/spaces').to(`space:${id}`).emit('broadcast:deleted', {
        roomId: id,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({ success: true, message: 'Agora Broadcast deleted successfully' });
  } catch (error) {
    logger.error('[ADMIN] Error deleting Agora Broadcast:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error deleting Agora Broadcast',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ---------------------------------------------------------------------------
// POST /:id/go-live — Start the broadcast
// ---------------------------------------------------------------------------
router.post('/:id/go-live', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id);
    if (!room) {
      return res.status(404).json({ message: 'Broadcast not found' });
    }

    if (!isAgoraBroadcast(room)) {
      return res.status(404).json({ message: 'Broadcast not found' });
    }

    if (room.status !== RoomStatus.SCHEDULED) {
      return res.status(400).json({
        message: `Cannot go live from status: ${room.status}`,
      });
    }

    // Create LiveKit room
    try {
      await createLiveKitRoomForRoom(String(id), room.maxParticipants);
    } catch (lkErr) {
      logger.error(`[ADMIN] Failed to create LiveKit room for broadcast ${id}, starting anyway:`, lkErr);
    }

    // If there is a pending streamUrl but no ingress yet, create the ingress now
    if (room.activeStreamUrl && !room.activeIngressId) {
      try {
        const ingress = await createRoomUrlIngress(String(id), room.activeStreamUrl);
        room.activeIngressId = ingress.ingressId;
      } catch (ingressErr) {
        logger.error(`[ADMIN] Failed to create URL ingress for broadcast ${id} during go-live:`, ingressErr);
      }
    }

    room.status = RoomStatus.LIVE;
    room.startedAt = new Date();
    await room.save();

    logger.info(`[ADMIN] Agora Broadcast went live: ${id} by admin ${userId}`);

    // Emit socket event
    const io = (global as any).io;
    if (io) {
      io.of('/spaces').to(`space:${id}`).emit('broadcast:live', {
        roomId: id,
        startedAt: room.startedAt,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({
      message: 'Broadcast is now live',
      room,
    });
  } catch (error) {
    logger.error('[ADMIN] Error starting Agora Broadcast:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error starting broadcast',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ---------------------------------------------------------------------------
// POST /:id/end — End the broadcast
// ---------------------------------------------------------------------------
router.post('/:id/end', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id);
    if (!room) {
      return res.status(404).json({ message: 'Broadcast not found' });
    }

    if (!isAgoraBroadcast(room)) {
      return res.status(404).json({ message: 'Broadcast not found' });
    }

    if (room.status !== RoomStatus.LIVE) {
      return res.status(400).json({
        message: `Cannot end broadcast with status: ${room.status}`,
      });
    }

    // Clean up active ingress
    if (room.activeIngressId) {
      deleteIngress(room.activeIngressId).catch((err) => {
        logger.error(`[ADMIN] Failed to delete ingress for broadcast ${id}:`, err);
      });
      room.activeIngressId = undefined;
      room.activeStreamUrl = undefined;
      room.rtmpUrl = undefined;
      room.rtmpStreamKey = undefined;
    }

    room.status = RoomStatus.ENDED;
    room.endedAt = new Date();
    await room.save();

    // Clean up LiveKit room
    deleteLiveKitRoomForRoom(String(id)).catch((err) => {
      logger.error(`[ADMIN] Failed to delete LiveKit room for broadcast ${id}:`, err);
    });

    logger.info(`[ADMIN] Agora Broadcast ended: ${id} by admin ${userId}`);

    // Emit socket event
    const io = (global as any).io;
    if (io) {
      io.of('/spaces').to(`space:${id}`).emit('broadcast:ended', {
        roomId: id,
        endedAt: room.endedAt,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({
      message: 'Broadcast ended successfully',
      room,
    });
  } catch (error) {
    logger.error('[ADMIN] Error ending Agora Broadcast:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error ending broadcast',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ---------------------------------------------------------------------------
// POST /:id/stream — Set/change stream URL for a live broadcast
// ---------------------------------------------------------------------------
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
      return res.status(404).json({ message: 'Broadcast not found' });
    }

    if (!isAgoraBroadcast(room)) {
      return res.status(404).json({ message: 'Broadcast not found' });
    }

    if (room.status !== RoomStatus.LIVE) {
      return res.status(400).json({ message: 'Broadcast must be live to set a stream' });
    }

    // If there's already an active ingress, delete it first
    if (room.activeIngressId) {
      await deleteIngress(room.activeIngressId);
    }

    // Create the URL ingress
    const ingress = await createRoomUrlIngress(String(id), trimmedUrl);

    room.activeIngressId = ingress.ingressId;
    room.activeStreamUrl = trimmedUrl;
    room.rtmpUrl = undefined;
    room.rtmpStreamKey = undefined;
    if (title !== undefined) room.streamTitle = title ? String(title).trim() : undefined;
    if (image !== undefined) room.streamImage = image ? String(image).trim() : undefined;
    if (description !== undefined) room.streamDescription = description ? String(description).trim() : undefined;
    await room.save();

    logger.info(`[ADMIN] Stream set on broadcast ${id}: ${trimmedUrl} by admin ${userId}`);

    // Notify listeners via socket
    const io = (global as any).io;
    if (io) {
      io.of('/spaces').to(`space:${id}`).emit('broadcast:stream:started', {
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
    logger.error('[ADMIN] Error setting stream on broadcast:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error starting stream',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ---------------------------------------------------------------------------
// DELETE /:id/stream — Stop stream on a live broadcast
// ---------------------------------------------------------------------------
router.delete('/:id/stream', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const room = await Room.findById(id);
    if (!room) {
      return res.status(404).json({ message: 'Broadcast not found' });
    }

    if (!isAgoraBroadcast(room)) {
      return res.status(404).json({ message: 'Broadcast not found' });
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

    logger.info(`[ADMIN] Stream stopped on broadcast ${id} by admin ${userId}`);

    // Notify listeners via socket
    const io = (global as any).io;
    if (io) {
      io.of('/spaces').to(`space:${id}`).emit('broadcast:stream:stopped', {
        roomId: id,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({ message: 'Stream stopped successfully' });
  } catch (error) {
    logger.error('[ADMIN] Error stopping stream on broadcast:', { userId: req.user?.id, roomId: req.params.id, error });
    res.status(500).json({
      message: 'Error stopping stream',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
