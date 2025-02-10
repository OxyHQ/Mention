import { io, Socket } from 'socket.io-client';
import { API_URL_SOCKET } from "@/config";
import { getData } from './storage';

let notificationSocket: Socket | null = null;
let retryCount = 0;
const MAX_RETRIES = 3;

export const initializeNotificationSocket = async (): Promise<Socket | null> => {
  if (notificationSocket?.connected) return notificationSocket;
  
  if (notificationSocket) {
    notificationSocket.disconnect();
    notificationSocket = null;
  }

  try {
    const token = await getData('accessToken');
    if (!token) {
      console.error('No access token available');
      return null;
    }

    const socket = io(API_URL_SOCKET, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 5,
      timeout: 10000,
      autoConnect: false
    });

    // Set up event handlers
    socket.on('connect', () => {
      console.log('Notification socket connected successfully');
      retryCount = 0;
    });

    socket.on('connect_error', async (error) => {
      console.error('Notification socket connection error:', error);
      if (retryCount < MAX_RETRIES) {
        retryCount++;
        const newToken = await getData('accessToken');
        if (socket && newToken) {
          console.log(`Retrying notification socket connection (${retryCount}/${MAX_RETRIES})...`);
          socket.auth = { token: newToken };
          socket.connect();
        }
      } else {
        console.error('Max notification socket connection retries reached');
        disconnectNotificationSocket();
      }
    });

    socket.on('disconnect', (reason) => {
      console.log('Notification socket disconnected:', reason);
      if (reason === 'io server disconnect') {
        socket.connect();
      }
    });

    socket.on('error', (error) => {
      console.error('Notification socket error:', error);
    });

    socket.connect();
    notificationSocket = socket;
    return socket;
  } catch (error) {
    console.error('Error initializing notification socket:', error);
    return null;
  }
};

export const getNotificationSocket = (): Socket | null => notificationSocket;

export const disconnectNotificationSocket = (): void => {
  if (notificationSocket) {
    notificationSocket.disconnect();
    notificationSocket = null;
    retryCount = 0;
  }
};