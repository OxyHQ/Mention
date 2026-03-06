import { Server, Socket, Namespace } from 'socket.io';
import { logger } from '../utils/logger';
import Room, { RoomStatus, RoomType, SpeakerPermission } from '../models/Room';
import { checkFollowAccess } from '../utils/privacyHelpers';
import { getRedisClient } from '../utils/redis';
import { updateRoomParticipantPermissions } from '../utils/livekit';

interface AuthenticatedSocket extends Socket {
  user?: { id: string; [key: string]: any };
}

// --- Redis key helpers ---

const ROOM_KEY = (roomId: string) => `room:${roomId}`;
const PARTICIPANTS_KEY = (roomId: string) => `room:${roomId}:participants`;
const REQUESTS_KEY = (roomId: string) => `room:${roomId}:requests`;

interface RedisParticipant {
  userId: string;
  socketId: string;
  role: 'host' | 'speaker' | 'listener';
  isMuted: boolean;
  joinedAt: string;
}

// --- Redis helper functions ---

async function redisSetRoom(roomId: string, hostId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isReady) return;
  await redis.set(ROOM_KEY(roomId), JSON.stringify({ hostId, createdAt: new Date().toISOString() }));
}

async function redisGetRoom(roomId: string): Promise<{ hostId: string } | null> {
  const redis = getRedisClient();
  if (!redis?.isReady) return null;
  const data = await redis.get(ROOM_KEY(roomId));
  return typeof data === 'string' ? JSON.parse(data) : null;
}

async function redisAddParticipant(roomId: string, participant: RedisParticipant): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isReady) return;
  await redis.hSet(PARTICIPANTS_KEY(roomId), participant.userId, JSON.stringify(participant));
}

async function redisRemoveParticipant(roomId: string, userId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isReady) return;
  await redis.hDel(PARTICIPANTS_KEY(roomId), userId);
}

async function redisGetParticipant(roomId: string, userId: string): Promise<RedisParticipant | null> {
  const redis = getRedisClient();
  if (!redis?.isReady) return null;
  const data = await redis.hGet(PARTICIPANTS_KEY(roomId), userId);
  return typeof data === 'string' ? JSON.parse(data) : null;
}

async function redisUpdateParticipant(roomId: string, userId: string, updates: Partial<RedisParticipant>): Promise<void> {
  const existing = await redisGetParticipant(roomId, userId);
  if (!existing) return;
  const updated = { ...existing, ...updates };
  const redis = getRedisClient();
  if (!redis?.isReady) return;
  await redis.hSet(PARTICIPANTS_KEY(roomId), userId, JSON.stringify(updated));
}

async function redisGetAllParticipants(roomId: string): Promise<Map<string, RedisParticipant>> {
  const result = new Map<string, RedisParticipant>();
  const redis = getRedisClient();
  if (!redis?.isReady) return result;
  const all = await redis.hGetAll(PARTICIPANTS_KEY(roomId));
  for (const [userId, data] of Object.entries(all)) {
    result.set(userId, JSON.parse(data));
  }
  return result;
}

async function redisAddSpeakerRequest(roomId: string, userId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isReady) return;
  await redis.hSet(REQUESTS_KEY(roomId), userId, JSON.stringify({ userId, requestedAt: new Date().toISOString() }));
}

async function redisRemoveSpeakerRequest(roomId: string, userId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isReady) return;
  await redis.hDel(REQUESTS_KEY(roomId), userId);
}

async function redisHasSpeakerRequest(roomId: string, userId: string): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis?.isReady) return false;
  const exists = await redis.hExists(REQUESTS_KEY(roomId), userId);
  return !!exists;
}

async function redisCleanupRoom(roomId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isReady) return;
  await redis.del([ROOM_KEY(roomId), PARTICIPANTS_KEY(roomId), REQUESTS_KEY(roomId)]);
  logger.debug(`Cleaned up Redis state for room: ${roomId}`);
}

// --- Utility functions ---

function getParticipantListFromMap(participants: Map<string, RedisParticipant>) {
  return Array.from(participants.values()).map(p => ({
    userId: p.userId,
    role: p.role,
    isMuted: p.isMuted,
    joinedAt: p.joinedAt,
  }));
}

async function broadcastParticipants(namespace: Namespace, roomId: string) {
  const participants = await redisGetAllParticipants(roomId);
  namespace.to(`room:${roomId}`).emit('room:participants:update', {
    roomId,
    participants: getParticipantListFromMap(participants),
    count: participants.size,
    timestamp: new Date().toISOString(),
  });
}

async function cleanupRoomIfEmpty(roomId: string) {
  const participants = await redisGetAllParticipants(roomId);
  if (participants.size === 0) {
    await redisCleanupRoom(roomId);
  }
}

/**
 * Determine the role for a user joining a room, based on the room's type.
 *
 * - BROADCAST: always 'listener' unless user is the host
 * - STAGE: 'listener' unless explicitly in speakers array
 * - TALK: apply speakerPermission logic (everyone / followers / invited)
 */
async function determineJoinRole(
  room: { host: string; speakers: string[]; speakerPermission?: string; type: string },
  userId: string
): Promise<'host' | 'speaker' | 'listener'> {
  // Host is always host
  if (room.host === userId) {
    return 'host';
  }

  const roomType = room.type as RoomType;

  switch (roomType) {
    case RoomType.BROADCAST:
      // Broadcast rooms: everyone except host is always a listener
      return 'listener';

    case RoomType.STAGE:
      // Stage rooms: only promote if explicitly in speakers array
      if (room.speakers.includes(userId)) {
        return 'speaker';
      }
      return 'listener';

    case RoomType.TALK:
    default: {
      // Talk rooms: apply speakerPermission logic
      if (room.speakers.includes(userId)) {
        return 'speaker';
      }
      const perm = (room.speakerPermission as SpeakerPermission) || SpeakerPermission.INVITED;
      if (perm === SpeakerPermission.EVERYONE) {
        return 'speaker';
      } else if (perm === SpeakerPermission.FOLLOWERS) {
        const hostFollowsUser = await checkFollowAccess(room.host, userId);
        if (hostFollowsUser) {
          return 'speaker';
        }
      }
      return 'listener';
    }
  }
}

/**
 * Initialize Room Socket Namespace
 * Handles real-time room control plane (roles, speaker requests, mute state).
 * Audio transport is handled by LiveKit WebRTC SFU.
 *
 * Supports three room types:
 *  - TALK: traditional open conversation with speakerPermission rules
 *  - STAGE: curated panel; only explicitly added speakers can publish
 *  - BROADCAST: one-to-many; only the host can publish audio
 */
export function initializeRoomSocket(io: Server): Namespace {
  const roomsNamespace = io.of('/rooms');

  roomsNamespace.on('connection', (socket: AuthenticatedSocket) => {
    const userId = socket.user?.id;

    if (!userId) {
      logger.warn('Unauthenticated client attempted to connect to rooms namespace');
      socket.disconnect(true);
      return;
    }

    logger.info(`User ${userId} connected to rooms namespace`);

    // Join user-specific room for targeted messages
    socket.join(`user:${userId}`);

    /**
     * Join a room
     */
    socket.on('room:join', async (data: { roomId: string }, callback?: (res: any) => void) => {
      try {
        const { roomId } = data || {};

        if (!roomId || typeof roomId !== 'string') {
          callback?.({ success: false, error: 'Invalid roomId' });
          return;
        }

        // Verify room exists and is live
        const room = await Room.findById(roomId).lean();
        if (!room) {
          callback?.({ success: false, error: 'Room not found' });
          return;
        }

        if (room.status !== RoomStatus.LIVE) {
          callback?.({ success: false, error: 'Room is not live' });
          return;
        }

        // Determine role based on room type
        const role = await determineJoinRole(room, userId);

        // Ensure room exists in Redis
        const existingRoom = await redisGetRoom(roomId);
        if (!existingRoom) {
          await redisSetRoom(roomId, room.host);
        }

        // Add participant to Redis
        await redisAddParticipant(roomId, {
          userId,
          socketId: socket.id,
          role,
          isMuted: true, // Start muted
          joinedAt: new Date().toISOString(),
        });

        // Join Socket.IO room
        socket.join(`room:${roomId}`);

        logger.debug(`User ${userId} joined room ${roomId} as ${role} (type: ${room.type})`);

        // Notify others
        socket.to(`room:${roomId}`).emit('room:user:joined', {
          userId,
          role,
          roomId,
          timestamp: new Date().toISOString(),
        });

        // Broadcast updated participant list
        await broadcastParticipants(roomsNamespace, roomId);

        // Return current state to the joining client
        const participants = await redisGetAllParticipants(roomId);
        callback?.({
          success: true,
          participants: getParticipantListFromMap(participants),
          myRole: role,
        });

        // Update DB: add to participants if not already there
        const isNewJoin = !room.participants.some((p: any) => String(p) === String(userId));
        await Room.findByIdAndUpdate(roomId, {
          $addToSet: { participants: userId },
          ...(isNewJoin ? { $inc: { 'stats.totalJoined': 1 } } : {}),
        });

        // Update peak listeners
        const currentCount = participants.size;
        if (currentCount > (room.stats?.peakListeners || 0)) {
          await Room.findByIdAndUpdate(roomId, {
            $max: { 'stats.peakListeners': currentCount },
          });
        }
      } catch (error) {
        logger.error('Error handling room:join:', error);
        callback?.({ success: false, error: 'Internal error' });
      }
    });

    /**
     * Leave a room
     */
    socket.on('room:leave', async (data: { roomId: string }) => {
      try {
        const { roomId } = data || {};
        if (!roomId || typeof roomId !== 'string') return;

        const participant = await redisGetParticipant(roomId, userId);
        if (!participant) return;

        // Remove from Redis
        await redisRemoveParticipant(roomId, userId);
        await redisRemoveSpeakerRequest(roomId, userId);
        socket.leave(`room:${roomId}`);

        logger.debug(`User ${userId} left room ${roomId}`);

        // Notify others
        socket.to(`room:${roomId}`).emit('room:user:left', {
          userId,
          roomId,
          timestamp: new Date().toISOString(),
        });

        // Broadcast updated participant list
        await broadcastParticipants(roomsNamespace, roomId);

        // Clean up room if empty
        await cleanupRoomIfEmpty(roomId);

        // Update DB: remove from participants
        await Room.findByIdAndUpdate(roomId, {
          $pull: { participants: userId },
        });
      } catch (error) {
        logger.error('Error handling room:leave:', error);
      }
    });

    /**
     * Mute/unmute toggle
     * Syncs mute state to other participants for UI display.
     * LiveKit mic publish/unpublish is handled client-side.
     * Works for ALL room types including BROADCAST (host needs mute/unmute).
     */
    socket.on('audio:mute', async (data: { roomId: string; isMuted: boolean }) => {
      try {
        const { roomId, isMuted } = data || {};
        if (!roomId || typeof isMuted !== 'boolean') return;

        const participant = await redisGetParticipant(roomId, userId);
        if (!participant) return;

        await redisUpdateParticipant(roomId, userId, { isMuted });
        logger.debug(`[audio:mute] User ${userId} ${isMuted ? 'muted' : 'unmuted'} in room ${roomId} (role: ${participant.role})`);

        // Broadcast mute state change
        roomsNamespace.to(`room:${roomId}`).emit('room:participant:mute', {
          userId,
          isMuted,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        logger.error('Error handling audio:mute:', error);
      }
    });

    /**
     * Request to speak (listener -> host)
     * Rejected for BROADCAST rooms (no speaking allowed).
     */
    socket.on('speaker:request', async (data: { roomId: string }, callback?: (res: any) => void) => {
      try {
        const { roomId } = data || {};
        if (!roomId) return;

        // Look up room type to enforce broadcast restriction
        const room = await Room.findById(roomId).lean();
        if (!room) return;

        if (room.type === RoomType.BROADCAST) {
          callback?.({ success: false, error: 'Speaker requests are not allowed in broadcast rooms' });
          return;
        }

        const participant = await redisGetParticipant(roomId, userId);
        if (!participant || participant.role !== 'listener') return;

        // For TALK rooms: if speakerPermission is 'everyone', auto-promote
        if (room.type === RoomType.TALK && room.speakerPermission === SpeakerPermission.EVERYONE) {
          await redisUpdateParticipant(roomId, userId, { role: 'speaker' });
          await broadcastParticipants(roomsNamespace, roomId);
          await Room.findByIdAndUpdate(roomId, { $addToSet: { speakers: userId } });
          // Grant LiveKit publish permission
          updateRoomParticipantPermissions(roomId, userId, true).catch(() => {});
          callback?.({ success: true, autoPromoted: true });
          return;
        }

        // Already requested
        if (await redisHasSpeakerRequest(roomId, userId)) {
          callback?.({ success: false, error: 'Request already pending' });
          return;
        }

        await redisAddSpeakerRequest(roomId, userId);

        // Notify host
        const redisRoom = await redisGetRoom(roomId);
        if (redisRoom) {
          roomsNamespace.to(`user:${redisRoom.hostId}`).emit('speaker:request:received', {
            roomId,
            userId,
            timestamp: new Date().toISOString(),
          });
        }

        logger.debug(`User ${userId} requested to speak in room ${roomId}`);
        callback?.({ success: true });
      } catch (error) {
        logger.error('Error handling speaker:request:', error);
        callback?.({ success: false, error: 'Internal error' });
      }
    });

    /**
     * Approve speaker request (host only)
     * Rejected for BROADCAST rooms.
     */
    socket.on('speaker:approve', async (data: { roomId: string; targetUserId: string }, callback?: (res: any) => void) => {
      try {
        const { roomId, targetUserId } = data || {};
        if (!roomId || !targetUserId) return;

        // Enforce broadcast restriction
        const room = await Room.findById(roomId).lean();
        if (room && room.type === RoomType.BROADCAST) {
          callback?.({ success: false, error: 'Cannot approve speakers in broadcast rooms' });
          return;
        }

        const redisRoom = await redisGetRoom(roomId);
        if (!redisRoom || redisRoom.hostId !== userId) return;

        const target = await redisGetParticipant(roomId, targetUserId);
        if (!target) return;

        // Promote to speaker
        await redisUpdateParticipant(roomId, targetUserId, { role: 'speaker' });
        await redisRemoveSpeakerRequest(roomId, targetUserId);

        // Grant LiveKit publish permission
        updateRoomParticipantPermissions(roomId, targetUserId, true).catch(() => {});

        // Notify the approved user
        roomsNamespace.to(`user:${targetUserId}`).emit('speaker:approved', {
          roomId,
          timestamp: new Date().toISOString(),
        });

        // Broadcast updated participant list
        await broadcastParticipants(roomsNamespace, roomId);

        // Update DB
        await Room.findByIdAndUpdate(roomId, {
          $addToSet: { speakers: targetUserId },
        });

        logger.info(`User ${targetUserId} approved as speaker in room ${roomId}`);
        callback?.({ success: true });
      } catch (error) {
        logger.error('Error handling speaker:approve:', error);
        callback?.({ success: false, error: 'Internal error' });
      }
    });

    /**
     * Deny speaker request (host only)
     */
    socket.on('speaker:deny', async (data: { roomId: string; targetUserId: string }) => {
      try {
        const { roomId, targetUserId } = data || {};
        if (!roomId || !targetUserId) return;

        const redisRoom = await redisGetRoom(roomId);
        if (!redisRoom || redisRoom.hostId !== userId) return;

        await redisRemoveSpeakerRequest(roomId, targetUserId);

        roomsNamespace.to(`user:${targetUserId}`).emit('speaker:denied', {
          roomId,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        logger.error('Error handling speaker:deny:', error);
      }
    });

    /**
     * Remove speaker (host only, demote back to listener)
     * Rejected for BROADCAST rooms.
     */
    socket.on('speaker:remove', async (data: { roomId: string; targetUserId: string }, callback?: (res: any) => void) => {
      try {
        const { roomId, targetUserId } = data || {};
        if (!roomId || !targetUserId) return;

        // Enforce broadcast restriction
        const room = await Room.findById(roomId).lean();
        if (room && room.type === RoomType.BROADCAST) {
          callback?.({ success: false, error: 'Cannot remove speakers in broadcast rooms' });
          return;
        }

        const redisRoom = await redisGetRoom(roomId);
        if (!redisRoom || redisRoom.hostId !== userId) return;

        const target = await redisGetParticipant(roomId, targetUserId);
        if (!target || target.role === 'host') return;

        await redisUpdateParticipant(roomId, targetUserId, { role: 'listener', isMuted: true });

        // Revoke LiveKit publish permission
        updateRoomParticipantPermissions(roomId, targetUserId, false).catch(() => {});

        roomsNamespace.to(`user:${targetUserId}`).emit('speaker:removed', {
          roomId,
          timestamp: new Date().toISOString(),
        });

        await broadcastParticipants(roomsNamespace, roomId);

        await Room.findByIdAndUpdate(roomId, {
          $pull: { speakers: targetUserId },
        });

        logger.info(`User ${targetUserId} removed as speaker from room ${roomId}`);
        callback?.({ success: true });
      } catch (error) {
        logger.error('Error handling speaker:remove:', error);
        callback?.({ success: false, error: 'Internal error' });
      }
    });

    /**
     * Handle disconnect - clean up all rooms this user is in
     */
    socket.on('disconnect', async (reason: string) => {
      logger.debug(`User ${userId} disconnected from rooms namespace: ${reason}`);

      // Check all rooms -- scan Socket.IO rooms to find which rooms they were in
      const socketRooms = Array.from(socket.rooms);
      for (const socketRoom of socketRooms) {
        if (!socketRoom.startsWith('room:')) continue;
        // Skip user-specific rooms (user:{id})
        const suffix = socketRoom.replace('room:', '');
        // user: rooms are joined via socket.join(`user:${userId}`) — skip them
        if (suffix === userId) continue;

        const roomId = suffix;

        const participant = await redisGetParticipant(roomId, userId);
        if (!participant || participant.socketId !== socket.id) continue;

        await redisRemoveParticipant(roomId, userId);
        await redisRemoveSpeakerRequest(roomId, userId);

        // Notify others
        roomsNamespace.to(`room:${roomId}`).emit('room:user:left', {
          userId,
          roomId,
          timestamp: new Date().toISOString(),
        });

        await broadcastParticipants(roomsNamespace, roomId);
        await cleanupRoomIfEmpty(roomId);

        // Update DB
        try {
          await Room.findByIdAndUpdate(roomId, {
            $pull: { participants: userId },
          });
        } catch (err) {
          logger.error(`Failed to update DB on disconnect for room ${roomId}:`, err);
        }
      }
    });

    /**
     * Handle errors
     */
    socket.on('error', (error: Error) => {
      logger.error('Rooms socket error:', error);
    });
  });

  roomsNamespace.on('connection_error', (error: Error) => {
    logger.error('Rooms namespace connection error:', error);
  });

  roomsNamespace.on('connect_error', (error: Error) => {
    logger.error('Rooms namespace connect error:', error);
  });

  logger.info('Rooms socket namespace initialized');

  return roomsNamespace;
}
