import { Server as SocketIOServer } from 'socket.io';
import { DefaultEventsMap } from 'socket.io/dist/typed-events';

let io: SocketIOServer<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap> | null = null;

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