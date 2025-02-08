import { io, Socket } from 'socket.io-client';
import { getData } from './storage';

const SOCKET_URL = process.env.API_URL_SOCKET || "ws://localhost:3000";
let socket: Socket | null = null;
let retryCount = 0;
const MAX_RETRIES = 3;

export const getSocket = async (namespace?: string) => {
  if (!socket) {
    try {
      const accessToken = await getData('accessToken');
      if (!accessToken) {
        console.error('No access token available for socket connection');
        return null;
      }

      const url = namespace ? `${SOCKET_URL}/${namespace}` : SOCKET_URL;
      
      socket = io(url, {
        withCredentials: true,
        auth: {
          token: accessToken
        },
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: 5,
        transports: ['websocket', 'polling']
      });

      socket.on('connect', () => {
        console.log('Socket connected successfully to:', url);
        retryCount = 0;
      });

      socket.on('connect_error', async (error) => {
        console.error('Socket connection error:', error);
        if (retryCount < MAX_RETRIES) {
          retryCount++;
          const newToken = await getData('accessToken');
          if (socket && newToken) {
            console.log(`Retrying socket connection (${retryCount}/${MAX_RETRIES})...`);
            socket.auth = { token: newToken };
            socket.connect();
          }
        } else {
          console.error('Max socket connection retries reached');
          disconnectSocket();
        }
      });

      socket.on('disconnect', (reason) => {
        console.log('Socket disconnected:', reason);
        if (reason === 'io server disconnect') {
          // Server initiated disconnect, try to reconnect
          socket?.connect();
        }
      });

      socket.on('error', (error) => {
        console.error('Socket error:', error);
      });
    } catch (error) {
      console.error('Error initializing socket:', error);
      return null;
    }
  }
  return socket;
};

export const disconnectSocket = () => {
  if (socket) {
    console.log('Manually disconnecting socket');
    socket.disconnect();
    socket = null;
    retryCount = 0;
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