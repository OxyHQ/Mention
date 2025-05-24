import { Server as SocketIOServer, Socket } from 'socket.io';
import { DefaultEventsMap } from 'socket.io/dist/typed-events';
import { logger } from '../utils/logger';
import jwt from 'jsonwebtoken';

interface AuthenticatedSocket extends Socket {
  user?: {
    id: string;
  };
}

export const setupPostSocket = (io: SocketIOServer<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap>) => {
  const postsNamespace = io.of('/posts');

  // Authentication middleware
  postsNamespace.use(async (socket: AuthenticatedSocket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token) {
        return next(new Error('Authentication token is required'));
      }

      const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET!) as { id: string };
      socket.user = { id: decoded.id };
      next();
    } catch (error) {
      next(new Error('Invalid authentication token'));
    }
  });

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