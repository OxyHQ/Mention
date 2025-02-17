import { io, Socket } from 'socket.io-client';
import { API_URL_SOCKET } from "@/config";
import { getData, storeData } from './storage';
import { toast } from 'sonner';
import { jwtDecode } from 'jwt-decode';
import { SOCKET_CONFIG, getReconnectDelay, debug } from './socketConfig';

let notificationSocket: Socket | null = null;
let retryCount = 0;
let tokenRefreshTimeout: NodeJS.Timeout | null = null;

const refreshSocketToken = async (socket: Socket) => {
  try {
    const newToken = await getData<string>('accessToken');
    if (!newToken) throw new Error('No access token available');
    
    if (socket) {
      socket.auth = { token: newToken };
      socket.disconnect().connect();
    }
  } catch (error) {
    debug.error('Token refresh failed:', error);
    disconnectNotificationSocket();
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

export const initializeNotificationSocket = async (): Promise<Socket | null> => {
  debug.log('initializeNotificationSocket called');
  if (notificationSocket?.connected) return notificationSocket;
  
  if (notificationSocket) {
    debug.log('Disconnecting existing socket');
    notificationSocket.disconnect();
    notificationSocket = null;
  }

  try {
    const token = await getData<string>('accessToken');
    if (!token) {
      debug.error('No access token available');
      return null;
    }

    // Decode token to get user ID
    try {
      const decoded = jwtDecode<{ id: string }>(token);
      debug.log('Decoded user ID from token:', decoded.id);
      await storeData('userId', decoded.id);
    } catch (error) {
      debug.error('Error decoding token:', error);
      return null;
    }

    debug.log('Creating new notifications socket connection');
    const socket = io(`${API_URL_SOCKET}`, {
      ...SOCKET_CONFIG,
      auth: { token },
      query: { namespace: 'notifications' }
    });

    // Set up event handlers before connecting
    socket.on('connect', () => {
      debug.log('Notification socket connected successfully');
      retryCount = 0;
      notificationSocket = socket;
      toast.success('Connected to notifications');
      setupTokenRefresh(socket);
    });

    socket.on('connect_error', async (error) => {
      debug.error('Notification socket connection error:', error);
      if (error.message?.includes('authentication')) {
        await refreshSocketToken(socket);
        return;
      }

      if (retryCount < (SOCKET_CONFIG.reconnectionAttempts || 5)) {
        retryCount++;
        const delay = getReconnectDelay(retryCount);
        debug.log(`Retrying notification socket connection (${retryCount}/${SOCKET_CONFIG.reconnectionAttempts}) in ${delay}ms...`);
        setTimeout(() => {
          if (socket) {
            socket.connect();
          }
        }, delay);
      } else {
        debug.error('Max notification socket connection retries reached');
        toast.error('Could not connect to notifications. Please refresh the page.');
        disconnectNotificationSocket();
      }
    });

    socket.io.on("error", (error) => {
      debug.error('Transport error:', error);
    });

    socket.io.on("reconnect_attempt", (attempt) => {
      debug.log('Reconnection attempt:', attempt);
    });

    socket.io.on("reconnect_error", (error) => {
      debug.error('Reconnection error:', error);
    });

    socket.io.on("reconnect_failed", () => {
      debug.error('Reconnection failed');
      toast.error('Notification connection lost. Please refresh the page.');
    });

    socket.on('disconnect', (reason) => {
      debug.log('Notification socket disconnected:', reason);
      if (reason === 'io server disconnect' || reason === 'transport close') {
        debug.log('Attempting reconnection...');
        socket.connect();
      }
      toast.error('Disconnected from notifications');
    });

    socket.on('error', (error) => {
      debug.error('Notification socket error:', error);
      toast.error('Notification error: ' + error?.message);
    });

    // Connect and wait for result with timeout
    socket.connect();
    
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout'));
        }, SOCKET_CONFIG.timeout || 20000);

        socket.once('connect', () => {
          clearTimeout(timeout);
          resolve(socket);
        });

        socket.once('connect_error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      
      return socket;
    } catch (error) {
      debug.error('Connection establishment failed:', error);
      socket.disconnect();
      throw error;
    }

  } catch (error) {
    debug.error('Error initializing notification socket:', error);
    return null;
  }
};

export const getNotificationSocket = (): Socket | null => notificationSocket;

export const disconnectNotificationSocket = (): void => {
  if (tokenRefreshTimeout) {
    clearTimeout(tokenRefreshTimeout);
    tokenRefreshTimeout = null;
  }

  if (notificationSocket) {
    console.log('Manually disconnecting notification socket');
    notificationSocket.disconnect();
    notificationSocket = null;
    retryCount = 0;
  }
};