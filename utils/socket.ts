import { io, Socket } from 'socket.io-client';
import { getData } from './storage';

const API_URL = process.env.API_URL || "http://localhost:3000";

let socket: Socket | null = null;
let retryCount = 0;
const MAX_RETRIES = 3;

export const getSocket = async () => {
  if (!socket) {
    try {
      const accessToken = await getData('accessToken');
      if (!accessToken) {
        console.error('No access token available for socket connection');
        return null;
      }

      socket = io(API_URL, {
        withCredentials: true,
        auth: {
          token: accessToken
        },
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: 5
      });

      socket.on('connect', () => {
        console.log('Socket connected successfully');
        retryCount = 0;
      });

      socket.on('connect_error', async (error) => {
        console.error('Socket connection error:', error);
        if (retryCount < MAX_RETRIES) {
          retryCount++;
          const newToken = await getData('accessToken');
          if (socket && newToken) {
            console.log('Retrying socket connection with new token...');
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