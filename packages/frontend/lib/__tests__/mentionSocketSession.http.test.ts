import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { OxyServices } from '@oxy.so/core';
import { createMentionSocketSession } from '../mentionSocketSession';
import { io } from 'socket.io-client';

const token = (userId: string, exp = 2_000_000_000) =>
  `e30.${Buffer.from(JSON.stringify({ userId, sessionId: userId, exp })).toString('base64url')}.fixture`;

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Socket condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function connectNotificationSocket(
  oxy: OxyServices,
  baseURL: string,
  events: {
    onNotification(): void;
    onContextEnd(): void;
  },
) {
  const session = createMentionSocketSession(oxy, baseURL, baseURL, events.onContextEnd);
  const socket = io(baseURL, { autoConnect: false, transports: ['websocket'], auth: session.auth });
  session.bind(() => {
    socket.removeAllListeners();
    socket.disconnect();
  });
  socket.on('notification', events.onNotification);
  socket.connect();
  return () => {
    session.dispose();
    socket.removeAllListeners();
    socket.disconnect();
  };
}

async function fixture() {
  const http = createServer();
  const io = new Server(http);
  const handshakes: string[] = [];
  io.use((socket, next) => {
    handshakes.push(socket.handshake.auth.token);
    next();
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const oxy = new OxyServices({ baseURL });
  return {
    io,
    oxy,
    baseURL,
    handshakes,
    async close() {
      oxy.dispose();
      await new Promise<void>((resolve) => io.close(() => resolve()));
    },
  };
}

test('connected notification socket is cut off on account switch, reconnects with shared refreshed authority and disposes', async () => {
  const f = await fixture();
  let notifications = 0;
  let ended = 0;
  let dispose = () => {};
  const events = {
    onNotification: () => {
      notifications++;
    },
    onContextEnd: () => {
      ended++;
    },
  };
  try {
    f.oxy.session.setAccessToken(token('A', 1));
    let refreshes = 0;
    f.oxy.http.setAuthRefreshHandler(async () => {
      refreshes++;
      return token('A');
    });
    dispose = connectNotificationSocket(f.oxy, f.baseURL, events);
    await until(() => f.io.sockets.sockets.size === 1);
    expect(f.handshakes).toEqual([token('A')]);
    expect(refreshes).toBe(1);
    f.io.emit('notification', { id: 'job-A' });
    await until(() => notifications === 1);
    f.oxy.session.setAccessToken(token('B'));
    expect(ended).toBe(1);
    f.io.emit('notification', { id: 'stale-A' });
    await until(() => f.io.sockets.sockets.size === 0);
    expect(notifications).toBe(1);
    dispose = connectNotificationSocket(f.oxy, f.baseURL, events);
    await until(() => f.io.sockets.sockets.size === 1);
    expect(f.handshakes).toEqual([token('A'), token('B')]);
    f.oxy.session.clear();
    await until(() => f.io.sockets.sockets.size === 0);
    expect(ended).toBe(2);
    dispose();
    f.oxy.session.setAccessToken(token('C'));
    expect(ended).toBe(2);
  } finally {
    dispose();
    await f.close();
  }
});

test('a pending handshake refresh cannot connect after switch or disposal', async () => {
  for (const change of ['switch', 'dispose'] as const) {
    const f = await fixture();
    let release: (() => void) | undefined;
    let arrived = false;
    let dispose = () => {};
    try {
      f.oxy.session.setAccessToken(token('A', 1));
      f.oxy.http.setAuthRefreshHandler(async () => {
        arrived = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return token('A');
      });
      dispose = connectNotificationSocket(f.oxy, f.baseURL, {
        onNotification: () => {},
        onContextEnd: () => {},
      });
      await until(() => arrived);
      if (change === 'switch') f.oxy.session.setAccessToken(token('B'));
      else dispose();
      release?.();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(f.handshakes).toEqual([]);
      expect(f.io.sockets.sockets.size).toBe(0);
      if (change === 'switch') expect(f.oxy.session.userId).toBe('B');
    } finally {
      release?.();
      dispose();
      await f.close();
    }
  }
});
