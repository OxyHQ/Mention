import { io, Socket } from 'socket.io-client';
import { getData, getSecureData } from './storage';
import { OXY_API_CONFIG } from "../config";
import { toast } from 'sonner';
import { SOCKET_CONFIG, getReconnectDelay, debug, isAuthError } from './socketConfig';
import { STORAGE_KEYS } from '../constants';

const SOCKET_URL = OXY_API_CONFIG.BASE_URL || "ws://localhost:3000";
let socket: Socket | null = null;
let retryCount = 0;
let tokenRefreshTimeout: NodeJS.Timeout | null = null;
let transportFallbackAttempted = false;

const refreshSocketToken = async (socket: Socket) => {
  try {
    const newToken = await getSecureData<string>(STORAGE_KEYS.ACCESS_TOKEN);
    if (!newToken) throw new Error('No access token available');
    
    if (socket) {
      socket.auth = { token: newToken };
      socket.disconnect().connect(); // Force reconnection with new token
    }
  } catch (error) {
    debug.error('Token refresh failed:', error);
    disconnectSocket();
  }
};

const setupTokenRefresh = (socket: Socket) => {
  if (tokenRefreshTimeout) {
    clearTimeout(tokenRefreshTimeout);
  }
  
  tokenRefreshTimeout = setTimeout(() => {
    refreshSocketToken(socket);
  }, 45 * 60 * 1000);
};

// Changed function signature to accept Socket | null
const attemptTransportFallback = (socket: Socket | null) => {
  if (!socket || !socket.io) return;
  if (!transportFallbackAttempted) {
    transportFallbackAttempted = true;
    debug.log('Attempting transport fallback to polling');
    socket.io.opts.transports = ['polling', 'websocket'];
    socket.connect();
  }
};

export const getSocket = async (namespace?: string) => {
  if (!socket) {
    try {
      const accessToken = await getSecureData<string>(STORAGE_KEYS.ACCESS_TOKEN);
      if (!accessToken) {
        debug.error('No access token available for socket connection');
        return null;
      }

      const url = namespace ? `${SOCKET_URL}/${namespace}` : SOCKET_URL;
      transportFallbackAttempted = false;
      
      socket = io(url, {
        ...SOCKET_CONFIG,
        auth: { token: accessToken }
      });

      socket.on('connect', () => {
        debug.log('Socket connected successfully to:', url);
        retryCount = 0;
        toast.success('Connected to server');
        setupTokenRefresh(socket!);
      });

      socket.on('connect_error', async (error) => {
        debug.error('Socket connection error:', error);
        if (isAuthError(error)) {
          await refreshSocketToken(socket!);
          return;
        }

        // Try transport fallback on initial connection errors
        if (!socket?.connected && !transportFallbackAttempted) {
          attemptTransportFallback(socket!);
          return;
        }

        if (retryCount < (SOCKET_CONFIG.reconnectionAttempts || 5)) {
          retryCount++;
          const delay = getReconnectDelay(retryCount);
          debug.log(`Retrying socket connection (${retryCount}/${SOCKET_CONFIG.reconnectionAttempts}) in ${delay}ms...`);
          setTimeout(() => {
            if (socket) {
              socket.connect();
            }
          }, delay);
        } else {
          debug.error('Max socket connection retries reached');
          toast.error('Could not connect to server. Please refresh the page.');
          disconnectSocket();
        }
      });

      // Handle transport-specific errors
      socket.io.on("error", (error) => {
        debug.error('Transport error:', error);
        if (!socket?.connected && !transportFallbackAttempted) {
          attemptTransportFallback(socket);
        }
      });

      socket.io.on("reconnect_attempt", (attempt) => {
        debug.log('Reconnection attempt:', attempt);
      });

      socket.io.on("reconnect_error", (error) => {
        debug.error('Reconnection error:', error);
        if (!socket?.connected && !transportFallbackAttempted) {
          attemptTransportFallback(socket);
        }
      });

      socket.io.on("reconnect_failed", () => {
        debug.error('Reconnection failed');
        toast.error('Connection lost. Please refresh the page.');
      });

      socket.on('disconnect', (reason) => {
        debug.log('Socket disconnected:', reason);
        if (reason === 'io server disconnect' || reason === 'transport close') {
          debug.log('Attempting to reconnect...');
          socket?.connect();
        }
        toast.error('Disconnected from server');
      });

      socket.on('error', (error) => {
        debug.error('Socket error:', error);
        toast.error('Connection error occurred');
      });

      socket.connect();
      
    } catch (error) {
      debug.error('Error initializing socket:', error);
      toast.error('Failed to initialize connection');
      return null;
    }
  }
  return socket;
};

export const disconnectSocket = () => {
  if (tokenRefreshTimeout) {
    clearTimeout(tokenRefreshTimeout);
    tokenRefreshTimeout = null;
  }
  
  if (socket) {
    console.log('Manually disconnecting socket');
    socket.disconnect();
    socket = null;
    retryCount = 0;
    transportFallbackAttempted = false;
  }
};

// Helper function to join a room
export const joinRoom = (socket: Socket, room: string) => {
  if (socket && socket.connected) {
    socket.emit('joinRoom', room);
    return true;
  }
  return false;
};

// Helper function to leave a room
export const leaveRoom = (socket: Socket, room: string) => {
  if (socket && socket.connected) {
    socket.emit('leaveRoom', room);
    return true;
  }
  return false;
};

// Initialize chat socket connection
export const initializeChatSocket = () => getSocket('chat');