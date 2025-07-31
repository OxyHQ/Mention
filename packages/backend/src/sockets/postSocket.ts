import { Server as SocketIOServer, Socket } from 'socket.io';
import { logger } from '../utils/logger';
import jwt from 'jsonwebtoken';

interface AuthenticatedSocket extends Socket {
  user?: {
    id: string;
  };
}

export const setupPostSocket = (io: SocketIOServer) => {
  const postsNamespace = io.of('/posts');

  postsNamespace.on('connection', (socket: AuthenticatedSocket) => {
    logger.info(`Client connected to posts namespace: ${socket.id}`);

    // Join user's room for personalized updates
    if (socket.user?.id) {
      const userRoom = `user:${socket.user.id}`;
      socket.join(userRoom);
    }

    socket.on('joinPost', (postId: string) => {
      const room = `post:${postId}`;
      socket.join(room);
      logger.info(`Client ${socket.id} joined room: ${room}`);
    });

    socket.on('leavePost', (postId: string) => {
      const room = `post:${postId}`;
      socket.leave(room);
      logger.info(`Client ${socket.id} left room: ${room}`);
    });

    socket.on('error', (error: Error) => {
      logger.error('Posts socket error:', error.message);
    });

    socket.on('disconnect', () => {
      logger.info(`Client disconnected from posts namespace: ${socket.id}`);
      if (socket.user?.id) {
        const userRoom = `user:${socket.user.id}`;
        socket.leave(userRoom);
      }
    });
  });

  return postsNamespace;
};