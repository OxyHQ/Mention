import type { Server as SocketIOServer } from 'socket.io';

let ioInstance: SocketIOServer | null = null;

/**
 * Register the Socket.IO server instance.
 * Called once during server startup.
 */
export function setIO(io: SocketIOServer): void {
  ioInstance = io;
}

/**
 * Get the Socket.IO server instance.
 * Returns null if called before server initialization.
 */
export function getIO(): SocketIOServer | null {
  return ioInstance;
}
