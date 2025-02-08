import { io, Socket } from 'socket.io-client';

const API_URL = process.env.API_URL || "http://localhost:3000";

let socket: Socket | null = null;

export const getSocket = () => {
  if (!socket) {
    socket = io(API_URL, {
      withCredentials: true,
      auth: {
        token: localStorage.getItem('accessToken')
      }
    });

    socket.on('connect', () => {
      console.log('Socket connected');
    });

    socket.on('connect_error', (error) => {
      console.error('Socket connection error:', error);
    });
  }
  return socket;
};

export const disconnectSocket = () => {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
};