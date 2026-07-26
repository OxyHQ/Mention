import type { Server as SocketIOServer } from 'socket.io';

/**
 * Late-bound Socket.IO seam for domain code that emits outside an HTTP handler.
 * Importing this module never creates a server or opens a socket.
 */
let runtimeSocketServer: SocketIOServer | undefined;

export function setRuntimeSocketServer(server: SocketIOServer): void {
  runtimeSocketServer = server;
}

export function getRuntimeSocketServer(): SocketIOServer | undefined {
  return runtimeSocketServer;
}

export function clearRuntimeSocketServer(server?: SocketIOServer): void {
  if (!server || runtimeSocketServer === server) {
    runtimeSocketServer = undefined;
  }
}
