import { Server as SocketIOServer } from 'socket.io';

let io: SocketIOServer | null = null;

export const initializeIO = (socketIO: SocketIOServer) => {
  io = socketIO;
};

export const getIO = () => {
  return io;
};

export const closeIO = () => {
  if (io) {
    io.close();
    io = null;
  }
};