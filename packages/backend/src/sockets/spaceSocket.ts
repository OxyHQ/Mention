import { Server, Socket, Namespace } from 'socket.io';
import { logger } from '../utils/logger';

interface AuthenticatedSocket extends Socket {
  user?: { id: string; [key: string]: any };
}

/**
 * Initialize Space Socket Namespace
 * Handles WebRTC signaling for audio rooms
 *
 * @param io - Socket.IO server instance
 * @returns Configured spaces namespace
 */
export function initializeSpaceSocket(io: Server): Namespace {
  const spacesNamespace = io.of('/spaces');

  spacesNamespace.on('connection', (socket: AuthenticatedSocket) => {
    logger.info(`Client connected to spaces namespace from ip: ${socket.handshake.address}`);

    const userId = socket.user?.id;

    if (!userId) {
      logger.warn('Unauthenticated client attempted to connect to spaces namespace');
      socket.disconnect(true);
      return;
    }

    /**
     * Join a space room
     */
    socket.on('space:join', (data: { spaceId: string }) => {
      try {
        const { spaceId } = data || {};

        if (!spaceId || typeof spaceId !== 'string') {
          logger.warn(`Invalid space:join data from ${userId}`);
          return;
        }

        const room = `space:${spaceId}`;
        socket.join(room);
        logger.debug(`User ${userId} joined space room: ${room}`);

        // Notify others in the room
        socket.to(room).emit('space:user:joined', {
          userId,
          spaceId,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.error('Error handling space:join:', error);
      }
    });

    /**
     * Leave a space room
     */
    socket.on('space:leave', (data: { spaceId: string }) => {
      try {
        const { spaceId } = data || {};

        if (!spaceId || typeof spaceId !== 'string') {
          logger.warn(`Invalid space:leave data from ${userId}`);
          return;
        }

        const room = `space:${spaceId}`;
        socket.leave(room);
        logger.debug(`User ${userId} left space room: ${room}`);

        // Notify others in the room
        socket.to(room).emit('space:user:left', {
          userId,
          spaceId,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.error('Error handling space:leave:', error);
      }
    });

    /**
     * WebRTC Offer
     * Sent by a peer to initiate WebRTC connection
     */
    socket.on('audio:offer', (data: {
      spaceId: string;
      targetUserId: string;
      offer: RTCSessionDescriptionInit;
    }) => {
      try {
        const { spaceId, targetUserId, offer } = data || {};

        if (!spaceId || !targetUserId || !offer) {
          logger.warn(`Invalid audio:offer data from ${userId}`);
          return;
        }

        logger.debug(`WebRTC offer from ${userId} to ${targetUserId} in space ${spaceId}`);

        // Forward offer to target user
        spacesNamespace.to(`user:${targetUserId}`).emit('audio:offer', {
          fromUserId: userId,
          spaceId,
          offer,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.error('Error handling audio:offer:', error);
      }
    });

    /**
     * WebRTC Answer
     * Response to an offer
     */
    socket.on('audio:answer', (data: {
      spaceId: string;
      targetUserId: string;
      answer: RTCSessionDescriptionInit;
    }) => {
      try {
        const { spaceId, targetUserId, answer } = data || {};

        if (!spaceId || !targetUserId || !answer) {
          logger.warn(`Invalid audio:answer data from ${userId}`);
          return;
        }

        logger.debug(`WebRTC answer from ${userId} to ${targetUserId} in space ${spaceId}`);

        // Forward answer to target user
        spacesNamespace.to(`user:${targetUserId}`).emit('audio:answer', {
          fromUserId: userId,
          spaceId,
          answer,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.error('Error handling audio:answer:', error);
      }
    });

    /**
     * ICE Candidate
     * WebRTC ICE candidate exchange
     */
    socket.on('ice:candidate', (data: {
      spaceId: string;
      targetUserId: string;
      candidate: RTCIceCandidateInit;
    }) => {
      try {
        const { spaceId, targetUserId, candidate } = data || {};

        if (!spaceId || !targetUserId || !candidate) {
          logger.warn(`Invalid ice:candidate data from ${userId}`);
          return;
        }

        logger.debug(`ICE candidate from ${userId} to ${targetUserId} in space ${spaceId}`);

        // Forward ICE candidate to target user
        spacesNamespace.to(`user:${targetUserId}`).emit('ice:candidate', {
          fromUserId: userId,
          spaceId,
          candidate,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.error('Error handling ice:candidate:', error);
      }
    });

    /**
     * Handle errors
     */
    socket.on('error', (error: Error) => {
      logger.error('Spaces socket error:', error);
    });

    /**
     * Handle disconnect
     */
    socket.on('disconnect', (reason: string) => {
      logger.debug(`User ${userId} disconnected from spaces namespace: ${reason}`);
    });
  });

  // Configure error handling for the namespace
  spacesNamespace.on('connection_error', (error: Error) => {
    logger.error('Spaces namespace connection error:', error);
  });

  spacesNamespace.on('connect_error', (error: Error) => {
    logger.error('Spaces namespace connect error:', error);
  });

  logger.info('Spaces socket namespace initialized');

  return spacesNamespace;
}
