import { beforeEach, describe, expect, it, vi } from 'vitest';
import { presenceRoom } from '@mention/shared-types';

vi.mock('../../services/ContentRoomLifecycle', () => ({
  registerContentRoomHandlers: vi.fn(),
}));

vi.mock('../../services/SocketPresenceLifecycle', () => ({
  registerSocketPresence: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../services/notificationReadState', () => ({
  markAllNotificationsRead: vi.fn(),
  markNotificationRead: vi.fn(),
}));

vi.mock('../../services/notificationInbox', () => ({
  resolveNotificationInboxIds: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createUserScopedOxyServices: vi.fn(),
}));

const { registerSocketHandlers } = await import('../../runtime/socketHandlers');

type Handler = (...args: unknown[]) => void;

/** A namespace reduced to what registration needs: nothing here is exercised. */
class StubNamespace {
  on(_event: string, _handler: Handler): void {}
}

/** The main-namespace connection socket, reduced to what presence rooms need. */
class FakeSocket {
  readonly id = 'socket-1';
  readonly rooms = new Set<string>();
  readonly handlers = new Map<string, Handler>();
  connected = true;
  user: { id: string } | undefined = { id: 'viewer-1' };
  handshake = { auth: {} };
  readonly emitted: Array<{ event: string; payload: unknown }> = [];

  on(event: string, handler: Handler) {
    this.handlers.set(event, handler);
  }

  join(room: string) {
    this.rooms.add(room);
  }

  leave(room: string) {
    this.rooms.delete(room);
  }

  emit(event: string, payload: unknown) {
    this.emitted.push({ event, payload });
  }

  send(event: string, ...args: unknown[]) {
    const handler = this.handlers.get(event);
    if (!handler) throw new Error(`nothing is listening for "${event}"`);
    handler(...args);
  }
}

/** The handler joins after an await, so the assertion has to come after it too. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup(): FakeSocket {
  let connectionHandler: Handler = () => undefined;
  const io = {
    on: (event: string, handler: Handler) => {
      if (event === 'connection') connectionHandler = handler;
    },
  };
  const presence = {
    isOnline: vi.fn(async () => false),
    getBulk: vi.fn(async () => ({})),
    broadcastPresence: vi.fn(),
  };
  const namespaces = {
    notificationsNamespace: new StubNamespace(),
    postsNamespace: new StubNamespace(),
    publicNamespace: new StubNamespace(),
  };

  registerSocketHandlers(
    io as never,
    namespaces as never,
    presence as never,
  );

  const socket = new FakeSocket();
  connectionHandler(socket);
  return socket;
}

describe('presence room membership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('joins the presence room for a valid target user id', async () => {
    const socket = setup();

    socket.send('subscribePresence', 'target-1');
    await settle();

    expect(socket.rooms.has(presenceRoom('target-1'))).toBe(true);
  });

  it('refuses a target id shaped like an injection attempt', async () => {
    const socket = setup();

    socket.send('subscribePresence', 'not valid/../../etc');
    await settle();

    expect(socket.rooms.size).toBe(0);
  });

  it('refuses a target id over the length bound', async () => {
    const socket = setup();

    socket.send('subscribePresence', 'a'.repeat(161));
    await settle();

    expect(socket.rooms.size).toBe(0);
  });

  it('leaves the presence room on unsubscribe', async () => {
    const socket = setup();

    socket.send('subscribePresence', 'target-1');
    await settle();
    socket.send('unsubscribePresence', 'target-1');

    expect(socket.rooms.has(presenceRoom('target-1'))).toBe(false);
  });

  it('does not leave a room for an invalid target id', async () => {
    const socket = setup();

    socket.send('subscribePresence', 'target-1');
    await settle();
    socket.send('unsubscribePresence', 'not valid');

    expect(socket.rooms.has(presenceRoom('target-1'))).toBe(true);
  });

  it('holds no more than the subscription ceiling, evicting the oldest', async () => {
    // subscribePresence is itself rate-limited to 20 events/10s, well under
    // the 100-room ceiling this test exercises — advance the clock between
    // batches so the ceiling, not the rate limiter, is what's under test.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const socket = setup();
      const ids = Array.from({ length: 103 }, (_, i) => `user-${i}`);
      for (let i = 0; i < ids.length; i += 1) {
        socket.send('subscribePresence', ids[i]);
        await settle();
        if ((i + 1) % 20 === 0) vi.advanceTimersByTime(10_001);
      }

      expect(socket.rooms.size).toBe(100);
      expect(socket.rooms.has(presenceRoom('user-0'))).toBe(false);
      expect(socket.rooms.has(presenceRoom(ids[ids.length - 1]))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
