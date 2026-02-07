import { Server, Socket, Namespace } from 'socket.io';
import { logger } from '../utils/logger';
import Space, { SpaceStatus, SpeakerPermission } from '../models/Space';
import { checkFollowAccess } from '../utils/privacyHelpers';
import { getRedisClient } from '../utils/redis';
import { updateParticipantPermissions } from '../utils/livekit';

interface AuthenticatedSocket extends Socket {
  user?: { id: string; [key: string]: any };
}

// --- Redis key helpers ---

const ROOM_KEY = (spaceId: string) => `space:room:${spaceId}`;
const PARTICIPANTS_KEY = (spaceId: string) => `space:room:${spaceId}:participants`;
const REQUESTS_KEY = (spaceId: string) => `space:room:${spaceId}:requests`;

interface RedisParticipant {
  userId: string;
  socketId: string;
  role: 'host' | 'speaker' | 'listener';
  isMuted: boolean;
  joinedAt: string;
}

// --- Redis helper functions ---

async function redisSetRoom(spaceId: string, hostId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isReady) return;
  await redis.set(ROOM_KEY(spaceId), JSON.stringify({ hostId, createdAt: new Date().toISOString() }));
}

async function redisGetRoom(spaceId: string): Promise<{ hostId: string } | null> {
  const redis = getRedisClient();
  if (!redis?.isReady) return null;
  const data = await redis.get(ROOM_KEY(spaceId));
  return typeof data === 'string' ? JSON.parse(data) : null;
}

async function redisAddParticipant(spaceId: string, participant: RedisParticipant): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isReady) return;
  await redis.hSet(PARTICIPANTS_KEY(spaceId), participant.userId, JSON.stringify(participant));
}

async function redisRemoveParticipant(spaceId: string, userId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isReady) return;
  await redis.hDel(PARTICIPANTS_KEY(spaceId), userId);
}

async function redisGetParticipant(spaceId: string, userId: string): Promise<RedisParticipant | null> {
  const redis = getRedisClient();
  if (!redis?.isReady) return null;
  const data = await redis.hGet(PARTICIPANTS_KEY(spaceId), userId);
  return typeof data === 'string' ? JSON.parse(data) : null;
}

async function redisUpdateParticipant(spaceId: string, userId: string, updates: Partial<RedisParticipant>): Promise<void> {
  const existing = await redisGetParticipant(spaceId, userId);
  if (!existing) return;
  const updated = { ...existing, ...updates };
  const redis = getRedisClient();
  if (!redis?.isReady) return;
  await redis.hSet(PARTICIPANTS_KEY(spaceId), userId, JSON.stringify(updated));
}

async function redisGetAllParticipants(spaceId: string): Promise<Map<string, RedisParticipant>> {
  const result = new Map<string, RedisParticipant>();
  const redis = getRedisClient();
  if (!redis?.isReady) return result;
  const all = await redis.hGetAll(PARTICIPANTS_KEY(spaceId));
  for (const [userId, data] of Object.entries(all)) {
    result.set(userId, JSON.parse(data));
  }
  return result;
}

async function redisAddSpeakerRequest(spaceId: string, userId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isReady) return;
  await redis.hSet(REQUESTS_KEY(spaceId), userId, JSON.stringify({ userId, requestedAt: new Date().toISOString() }));
}

async function redisRemoveSpeakerRequest(spaceId: string, userId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isReady) return;
  await redis.hDel(REQUESTS_KEY(spaceId), userId);
}

async function redisHasSpeakerRequest(spaceId: string, userId: string): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis?.isReady) return false;
  const exists = await redis.hExists(REQUESTS_KEY(spaceId), userId);
  return !!exists;
}

async function redisCleanupRoom(spaceId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isReady) return;
  await redis.del([ROOM_KEY(spaceId), PARTICIPANTS_KEY(spaceId), REQUESTS_KEY(spaceId)]);
  logger.debug(`Cleaned up Redis state for space: ${spaceId}`);
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

async function broadcastParticipants(namespace: Namespace, spaceId: string) {
  const participants = await redisGetAllParticipants(spaceId);
  namespace.to(`space:${spaceId}`).emit('space:participants:update', {
    spaceId,
    participants: getParticipantListFromMap(participants),
    count: participants.size,
    timestamp: new Date().toISOString(),
  });
}

async function cleanupRoomIfEmpty(spaceId: string) {
  const participants = await redisGetAllParticipants(spaceId);
  if (participants.size === 0) {
    await redisCleanupRoom(spaceId);
  }
}

/**
 * Initialize Space Socket Namespace
 * Handles real-time space control plane (roles, speaker requests, mute state).
 * Audio transport is handled by LiveKit WebRTC SFU.
 */
export function initializeSpaceSocket(io: Server): Namespace {
  const spacesNamespace = io.of('/spaces');

  spacesNamespace.on('connection', (socket: AuthenticatedSocket) => {
    const userId = socket.user?.id;

    if (!userId) {
      logger.warn('Unauthenticated client attempted to connect to spaces namespace');
      socket.disconnect(true);
      return;
    }

    logger.info(`User ${userId} connected to spaces namespace`);

    // Join user-specific room for targeted messages
    socket.join(`user:${userId}`);

    /**
     * Join a space room
     */
    socket.on('space:join', async (data: { spaceId: string }, callback?: (res: any) => void) => {
      try {
        const { spaceId } = data || {};

        if (!spaceId || typeof spaceId !== 'string') {
          callback?.({ success: false, error: 'Invalid spaceId' });
          return;
        }

        // Verify space exists and is live
        const space = await Space.findById(spaceId).lean();
        if (!space) {
          callback?.({ success: false, error: 'Space not found' });
          return;
        }

        if (space.status !== SpaceStatus.LIVE) {
          callback?.({ success: false, error: 'Space is not live' });
          return;
        }

        // Determine role
        let role: 'host' | 'speaker' | 'listener' = 'listener';
        if (space.host === userId) {
          role = 'host';
        } else if (space.speakers.includes(userId)) {
          role = 'speaker';
        } else {
          // Apply speakerPermission rules for new joiners
          const perm = space.speakerPermission || SpeakerPermission.INVITED;
          if (perm === SpeakerPermission.EVERYONE) {
            role = 'speaker';
          } else if (perm === SpeakerPermission.FOLLOWERS) {
            const hostFollowsUser = await checkFollowAccess(space.host, userId);
            if (hostFollowsUser) {
              role = 'speaker';
            }
          }
        }

        // Ensure room exists in Redis
        const existingRoom = await redisGetRoom(spaceId);
        if (!existingRoom) {
          await redisSetRoom(spaceId, space.host);
        }

        // Add participant to Redis
        await redisAddParticipant(spaceId, {
          userId,
          socketId: socket.id,
          role,
          isMuted: true, // Start muted
          joinedAt: new Date().toISOString(),
        });

        // Join Socket.IO room
        socket.join(`space:${spaceId}`);

        logger.debug(`User ${userId} joined space ${spaceId} as ${role}`);

        // Notify others
        socket.to(`space:${spaceId}`).emit('space:user:joined', {
          userId,
          role,
          spaceId,
          timestamp: new Date().toISOString(),
        });

        // Broadcast updated participant list
        await broadcastParticipants(spacesNamespace, spaceId);

        // Return current state to the joining client
        const participants = await redisGetAllParticipants(spaceId);
        callback?.({
          success: true,
          participants: getParticipantListFromMap(participants),
          myRole: role,
        });

        // Update DB: add to participants if not already there
        await Space.findByIdAndUpdate(spaceId, {
          $addToSet: { participants: userId },
          $inc: { 'stats.totalJoined': 1 },
        });

        // Update peak listeners
        const currentCount = participants.size;
        if (currentCount > (space.stats?.peakListeners || 0)) {
          await Space.findByIdAndUpdate(spaceId, {
            $max: { 'stats.peakListeners': currentCount },
          });
        }
      } catch (error) {
        logger.error('Error handling space:join:', error);
        callback?.({ success: false, error: 'Internal error' });
      }
    });

    /**
     * Leave a space room
     */
    socket.on('space:leave', async (data: { spaceId: string }) => {
      try {
        const { spaceId } = data || {};
        if (!spaceId || typeof spaceId !== 'string') return;

        const participant = await redisGetParticipant(spaceId, userId);
        if (!participant) return;

        // Remove from Redis
        await redisRemoveParticipant(spaceId, userId);
        await redisRemoveSpeakerRequest(spaceId, userId);
        socket.leave(`space:${spaceId}`);

        logger.debug(`User ${userId} left space ${spaceId}`);

        // Notify others
        socket.to(`space:${spaceId}`).emit('space:user:left', {
          userId,
          spaceId,
          timestamp: new Date().toISOString(),
        });

        // Broadcast updated participant list
        await broadcastParticipants(spacesNamespace, spaceId);

        // Clean up room if empty
        await cleanupRoomIfEmpty(spaceId);

        // Update DB: remove from participants
        await Space.findByIdAndUpdate(spaceId, {
          $pull: { participants: userId },
        });
      } catch (error) {
        logger.error('Error handling space:leave:', error);
      }
    });

    /**
     * Mute/unmute toggle
     * Syncs mute state to other participants for UI display.
     * LiveKit mic publish/unpublish is handled client-side.
     */
    socket.on('audio:mute', async (data: { spaceId: string; isMuted: boolean }) => {
      try {
        const { spaceId, isMuted } = data || {};
        if (!spaceId || typeof isMuted !== 'boolean') return;

        const participant = await redisGetParticipant(spaceId, userId);
        if (!participant) return;

        await redisUpdateParticipant(spaceId, userId, { isMuted });
        logger.debug(`[audio:mute] User ${userId} ${isMuted ? 'muted' : 'unmuted'} in space ${spaceId} (role: ${participant.role})`);

        // Broadcast mute state change
        spacesNamespace.to(`space:${spaceId}`).emit('space:participant:mute', {
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
     */
    socket.on('speaker:request', async (data: { spaceId: string }) => {
      try {
        const { spaceId } = data || {};
        if (!spaceId) return;

        const participant = await redisGetParticipant(spaceId, userId);
        if (!participant || participant.role !== 'listener') return;

        // If speakerPermission is 'everyone', auto-promote
        const space = await Space.findById(spaceId).lean();
        if (space && space.speakerPermission === SpeakerPermission.EVERYONE) {
          await redisUpdateParticipant(spaceId, userId, { role: 'speaker' });
          await broadcastParticipants(spacesNamespace, spaceId);
          await Space.findByIdAndUpdate(spaceId, { $addToSet: { speakers: userId } });
          // Grant LiveKit publish permission
          updateParticipantPermissions(spaceId, userId, true).catch(() => {});
          return;
        }

        // Already requested
        if (await redisHasSpeakerRequest(spaceId, userId)) return;

        await redisAddSpeakerRequest(spaceId, userId);

        // Notify host
        const room = await redisGetRoom(spaceId);
        if (room) {
          spacesNamespace.to(`user:${room.hostId}`).emit('speaker:request:received', {
            spaceId,
            userId,
            timestamp: new Date().toISOString(),
          });
        }

        logger.debug(`User ${userId} requested to speak in space ${spaceId}`);
      } catch (error) {
        logger.error('Error handling speaker:request:', error);
      }
    });

    /**
     * Approve speaker request (host only)
     */
    socket.on('speaker:approve', async (data: { spaceId: string; targetUserId: string }) => {
      try {
        const { spaceId, targetUserId } = data || {};
        if (!spaceId || !targetUserId) return;

        const room = await redisGetRoom(spaceId);
        if (!room || room.hostId !== userId) return;

        const target = await redisGetParticipant(spaceId, targetUserId);
        if (!target) return;

        // Promote to speaker
        await redisUpdateParticipant(spaceId, targetUserId, { role: 'speaker' });
        await redisRemoveSpeakerRequest(spaceId, targetUserId);

        // Grant LiveKit publish permission
        updateParticipantPermissions(spaceId, targetUserId, true).catch(() => {});

        // Notify the approved user
        spacesNamespace.to(`user:${targetUserId}`).emit('speaker:approved', {
          spaceId,
          timestamp: new Date().toISOString(),
        });

        // Broadcast updated participant list
        await broadcastParticipants(spacesNamespace, spaceId);

        // Update DB
        await Space.findByIdAndUpdate(spaceId, {
          $addToSet: { speakers: targetUserId },
        });

        logger.info(`User ${targetUserId} approved as speaker in space ${spaceId}`);
      } catch (error) {
        logger.error('Error handling speaker:approve:', error);
      }
    });

    /**
     * Deny speaker request (host only)
     */
    socket.on('speaker:deny', async (data: { spaceId: string; targetUserId: string }) => {
      try {
        const { spaceId, targetUserId } = data || {};
        if (!spaceId || !targetUserId) return;

        const room = await redisGetRoom(spaceId);
        if (!room || room.hostId !== userId) return;

        await redisRemoveSpeakerRequest(spaceId, targetUserId);

        spacesNamespace.to(`user:${targetUserId}`).emit('speaker:denied', {
          spaceId,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        logger.error('Error handling speaker:deny:', error);
      }
    });

    /**
     * Remove speaker (host only, demote back to listener)
     */
    socket.on('speaker:remove', async (data: { spaceId: string; targetUserId: string }) => {
      try {
        const { spaceId, targetUserId } = data || {};
        if (!spaceId || !targetUserId) return;

        const room = await redisGetRoom(spaceId);
        if (!room || room.hostId !== userId) return;

        const target = await redisGetParticipant(spaceId, targetUserId);
        if (!target || target.role === 'host') return;

        await redisUpdateParticipant(spaceId, targetUserId, { role: 'listener', isMuted: true });

        // Revoke LiveKit publish permission
        updateParticipantPermissions(spaceId, targetUserId, false).catch(() => {});

        spacesNamespace.to(`user:${targetUserId}`).emit('speaker:removed', {
          spaceId,
          timestamp: new Date().toISOString(),
        });

        await broadcastParticipants(spacesNamespace, spaceId);

        await Space.findByIdAndUpdate(spaceId, {
          $pull: { speakers: targetUserId },
        });

        logger.info(`User ${targetUserId} removed as speaker from space ${spaceId}`);
      } catch (error) {
        logger.error('Error handling speaker:remove:', error);
      }
    });

    /**
     * Handle disconnect - clean up all rooms this user is in
     */
    socket.on('disconnect', async (reason: string) => {
      logger.debug(`User ${userId} disconnected from spaces namespace: ${reason}`);

      // Check all rooms — scan Redis for this user's participation
      // We use the socket rooms to find which spaces they were in
      const rooms = Array.from(socket.rooms);
      for (const room of rooms) {
        if (!room.startsWith('space:')) continue;
        const spaceId = room.replace('space:', '');

        const participant = await redisGetParticipant(spaceId, userId);
        if (!participant || participant.socketId !== socket.id) continue;

        await redisRemoveParticipant(spaceId, userId);
        await redisRemoveSpeakerRequest(spaceId, userId);

        // Notify others
        spacesNamespace.to(`space:${spaceId}`).emit('space:user:left', {
          userId,
          spaceId,
          timestamp: new Date().toISOString(),
        });

        await broadcastParticipants(spacesNamespace, spaceId);
        await cleanupRoomIfEmpty(spaceId);

        // Update DB
        try {
          await Space.findByIdAndUpdate(spaceId, {
            $pull: { participants: userId },
          });
        } catch (err) {
          logger.error(`Failed to update DB on disconnect for space ${spaceId}:`, err);
        }
      }
    });

    /**
     * Handle errors
     */
    socket.on('error', (error: Error) => {
      logger.error('Spaces socket error:', error);
    });
  });

  spacesNamespace.on('connection_error', (error: Error) => {
    logger.error('Spaces namespace connection error:', error);
  });

  spacesNamespace.on('connect_error', (error: Error) => {
    logger.error('Spaces namespace connect error:', error);
  });

  logger.info('Spaces socket namespace initialized');

  return spacesNamespace;
}
