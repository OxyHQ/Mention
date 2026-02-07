import { Server, Socket, Namespace } from 'socket.io';
import { logger } from '../utils/logger';
import Space, { SpaceStatus, SpeakerPermission } from '../models/Space';
import { checkFollowAccess } from '../utils/privacyHelpers';

interface AuthenticatedSocket extends Socket {
  user?: { id: string; [key: string]: any };
}

// --- In-memory room state ---

interface SpaceParticipant {
  userId: string;
  socketId: string;
  role: 'host' | 'speaker' | 'listener';
  isMuted: boolean;
  joinedAt: string;
}

interface SpaceRoom {
  spaceId: string;
  hostId: string;
  participants: Map<string, SpaceParticipant>; // keyed by userId
  speakerRequests: Map<string, { userId: string; requestedAt: string }>;
}

const activeRooms = new Map<string, SpaceRoom>();

function getParticipantList(room: SpaceRoom) {
  return Array.from(room.participants.values()).map(p => ({
    userId: p.userId,
    role: p.role,
    isMuted: p.isMuted,
    joinedAt: p.joinedAt,
  }));
}

function broadcastParticipants(namespace: Namespace, room: SpaceRoom) {
  namespace.to(`space:${room.spaceId}`).emit('space:participants:update', {
    spaceId: room.spaceId,
    participants: getParticipantList(room),
    count: room.participants.size,
    timestamp: new Date().toISOString(),
  });
}

// Clean up a room if empty
function cleanupRoomIfEmpty(spaceId: string) {
  const room = activeRooms.get(spaceId);
  if (room && room.participants.size === 0) {
    activeRooms.delete(spaceId);
    logger.debug(`Cleaned up empty space room: ${spaceId}`);
  }
}

/**
 * Initialize Space Socket Namespace
 * Handles real-time audio spaces with room management and audio relay
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
          const perm = (space as any).speakerPermission || SpeakerPermission.INVITED;
          if (perm === SpeakerPermission.EVERYONE) {
            role = 'speaker';
          } else if (perm === SpeakerPermission.FOLLOWERS) {
            const hostFollowsUser = await checkFollowAccess(space.host, userId);
            if (hostFollowsUser) {
              role = 'speaker';
            }
          }
          // INVITED: stays as 'listener' (default)
        }

        // Create or get room
        let room = activeRooms.get(spaceId);
        if (!room) {
          room = {
            spaceId,
            hostId: space.host,
            participants: new Map(),
            speakerRequests: new Map(),
          };
          activeRooms.set(spaceId, room);
        }

        // Add participant
        room.participants.set(userId, {
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
        broadcastParticipants(spacesNamespace, room);

        // Return current state to the joining client
        callback?.({
          success: true,
          participants: getParticipantList(room),
          myRole: role,
        });

        // Update DB: add to participants if not already there
        await Space.findByIdAndUpdate(spaceId, {
          $addToSet: { participants: userId },
          $inc: { 'stats.totalJoined': 1 },
        });

        // Update peak listeners
        const currentCount = room.participants.size;
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

        const room = activeRooms.get(spaceId);
        if (!room) return;

        const participant = room.participants.get(userId);
        if (!participant) return;

        // Remove from room
        room.participants.delete(userId);
        room.speakerRequests.delete(userId);
        socket.leave(`space:${spaceId}`);

        logger.debug(`User ${userId} left space ${spaceId}`);

        // Notify others
        socket.to(`space:${spaceId}`).emit('space:user:left', {
          userId,
          spaceId,
          timestamp: new Date().toISOString(),
        });

        // Broadcast updated participant list
        broadcastParticipants(spacesNamespace, room);

        // Clean up room if empty
        cleanupRoomIfEmpty(spaceId);

        // Update DB: remove from participants
        await Space.findByIdAndUpdate(spaceId, {
          $pull: { participants: userId },
        });
      } catch (error) {
        logger.error('Error handling space:leave:', error);
      }
    });

    /**
     * Audio data relay
     * Speaker sends audio chunk, server broadcasts to all others in room
     */
    socket.on('audio:data', (data: { spaceId: string; chunk: string; sequence: number }) => {
      try {
        const { spaceId, chunk, sequence } = data || {};
        if (!spaceId || !chunk) {
          logger.debug(`[audio:data] Rejected: missing spaceId or chunk from user ${userId}`);
          return;
        }

        const room = activeRooms.get(spaceId);
        if (!room) {
          logger.debug(`[audio:data] Rejected: no active room for space ${spaceId}`);
          return;
        }

        const participant = room.participants.get(userId);
        if (!participant) {
          logger.debug(`[audio:data] Rejected: user ${userId} not in room ${spaceId}`);
          return;
        }

        // Only speakers and hosts can send audio
        if (participant.role === 'listener') {
          logger.debug(`[audio:data] Rejected: user ${userId} is a listener`);
          return;
        }

        // Don't relay if muted
        if (participant.isMuted) {
          logger.debug(`[audio:data] Rejected: user ${userId} is muted`);
          return;
        }

        // Broadcast to all others in the room (not back to sender)
        socket.to(`space:${spaceId}`).emit('audio:data', {
          userId,
          chunk,
          sequence,
          timestamp: Date.now(),
        });
      } catch (error) {
        logger.error('Error handling audio:data:', error);
      }
    });

    /**
     * Mute/unmute toggle
     */
    socket.on('audio:mute', (data: { spaceId: string; isMuted: boolean }) => {
      try {
        const { spaceId, isMuted } = data || {};
        if (!spaceId || typeof isMuted !== 'boolean') return;

        const room = activeRooms.get(spaceId);
        if (!room) return;

        const participant = room.participants.get(userId);
        if (!participant) return;

        participant.isMuted = isMuted;
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
     * Request to speak (listener → host)
     */
    socket.on('speaker:request', async (data: { spaceId: string }) => {
      try {
        const { spaceId } = data || {};
        if (!spaceId) return;

        const room = activeRooms.get(spaceId);
        if (!room) return;

        const participant = room.participants.get(userId);
        if (!participant || participant.role !== 'listener') return;

        // If speakerPermission is 'everyone', auto-promote instead of requesting
        const space = await Space.findById(spaceId).lean();
        if (space && (space as any).speakerPermission === SpeakerPermission.EVERYONE) {
          participant.role = 'speaker';
          broadcastParticipants(spacesNamespace, room);
          await Space.findByIdAndUpdate(spaceId, { $addToSet: { speakers: userId } });
          return;
        }

        // Already requested
        if (room.speakerRequests.has(userId)) return;

        room.speakerRequests.set(userId, {
          userId,
          requestedAt: new Date().toISOString(),
        });

        // Notify host
        spacesNamespace.to(`user:${room.hostId}`).emit('speaker:request:received', {
          spaceId,
          userId,
          timestamp: new Date().toISOString(),
        });

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

        const room = activeRooms.get(spaceId);
        if (!room) return;

        // Only host can approve
        if (room.hostId !== userId) return;

        const target = room.participants.get(targetUserId);
        if (!target) return;

        // Promote to speaker
        target.role = 'speaker';
        room.speakerRequests.delete(targetUserId);

        // Notify the approved user
        spacesNamespace.to(`user:${targetUserId}`).emit('speaker:approved', {
          spaceId,
          timestamp: new Date().toISOString(),
        });

        // Broadcast updated participant list
        broadcastParticipants(spacesNamespace, room);

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
    socket.on('speaker:deny', (data: { spaceId: string; targetUserId: string }) => {
      try {
        const { spaceId, targetUserId } = data || {};
        if (!spaceId || !targetUserId) return;

        const room = activeRooms.get(spaceId);
        if (!room) return;

        if (room.hostId !== userId) return;

        room.speakerRequests.delete(targetUserId);

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

        const room = activeRooms.get(spaceId);
        if (!room) return;

        if (room.hostId !== userId) return;

        const target = room.participants.get(targetUserId);
        if (!target || target.role === 'host') return;

        target.role = 'listener';
        target.isMuted = true;

        spacesNamespace.to(`user:${targetUserId}`).emit('speaker:removed', {
          spaceId,
          timestamp: new Date().toISOString(),
        });

        broadcastParticipants(spacesNamespace, room);

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

      for (const [spaceId, room] of activeRooms.entries()) {
        const participant = room.participants.get(userId);
        if (!participant || participant.socketId !== socket.id) continue;

        room.participants.delete(userId);
        room.speakerRequests.delete(userId);

        // Notify others
        spacesNamespace.to(`space:${spaceId}`).emit('space:user:left', {
          userId,
          spaceId,
          timestamp: new Date().toISOString(),
        });

        broadcastParticipants(spacesNamespace, room);
        cleanupRoomIfEmpty(spaceId);

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

/**
 * Get the active rooms map (for use by REST routes to emit events)
 */
export function getActiveRooms(): Map<string, SpaceRoom> {
  return activeRooms;
}
