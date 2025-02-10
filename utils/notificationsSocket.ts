import { io, Socket } from 'socket.io-client';
import { API_URL_SOCKET } from "@/config";
import { getData, storeData } from './storage';
import { toast } from 'sonner';
import { jwtDecode } from 'jwt-decode';

let notificationSocket: Socket | null = null;
let retryCount = 0;
const MAX_RETRIES = 3;

export const initializeNotificationSocket = async (): Promise<Socket | null> => {
  console.log('initializeNotificationSocket called');
  if (notificationSocket?.connected) return notificationSocket;
  
  if (notificationSocket) {
    console.log('Disconnecting existing socket');
    notificationSocket.disconnect();
    notificationSocket = null;
  }

  try {
    const token = await getData<string>('accessToken');
    if (!token) {
      console.error('No access token available');
      return null;
    }

    // Decode token to get user ID
    try {
      const decoded = jwtDecode<{ id: string }>(token);
      console.log('Decoded user ID from token:', decoded.id);
      await storeData('userId', decoded.id);
    } catch (error) {
      console.error('Error decoding token:', error);
      return null;
    }

    console.log('Creating new notifications socket connection');
    const socket = io(`${API_URL_SOCKET}`, {
      path: '/socket.io',
      auth: { token },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 5,
      timeout: 10000,
      forceNew: true,
      autoConnect: false,
      query: { namespace: 'notifications' }
    });

    // Set up event handlers before connecting
    socket.on('connect', () => {
      console.log('Notification socket connected successfully');
      retryCount = 0;
      notificationSocket = socket;
      toast.success('Connected to notifications');
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
        toast.error('Failed to connect to notifications');
        disconnectNotificationSocket();
      }
    });

    socket.on('disconnect', (reason) => {
      console.log('Notification socket disconnected:', reason);
      if (reason === 'io server disconnect' || reason === 'transport close') {
        console.log('Attempting reconnection...');
        socket.connect();
      }
      toast.error('Disconnected from notifications');
    });

    socket.on('error', (error) => {
      console.error('Notification socket error:', error);
      toast.error('Notification error: ' + error?.message);
    });

    // Connect and wait for result
    socket.connect();
    
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout'));
        }, 5000);

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
      console.error('Connection establishment failed:', error);
      socket.disconnect();
      throw error;
    }

  } catch (error) {
    console.error('Error initializing notification socket:', error);
    return null;
  }
};

export const getNotificationSocket = (): Socket | null => notificationSocket;

export const disconnectNotificationSocket = (): void => {
  if (notificationSocket) {
    console.log('Manually disconnecting notification socket');
    notificationSocket.disconnect();
    notificationSocket = null;
    retryCount = 0;
  }
};