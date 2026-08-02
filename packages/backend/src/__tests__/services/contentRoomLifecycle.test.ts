import type { Socket } from 'socket.io';
import { postEngagementRoom } from '@mention/shared-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const canViewerReadPostId = vi.fn<(postId: string, viewerId: string, options?: unknown) => Promise<boolean>>();

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: {
    canViewerReadPostId: (...args: [string, string, unknown?]) => canViewerReadPostId(...args),
  },
}));

const createScopedOxyClient = vi.fn(() => undefined);
vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: (...args: unknown[]) => createScopedOxyClient(...args),
}));

const {
  registerContentRoomHandlers,
  MAX_POST_ROOMS_PER_SOCKET,
} = await import('../../services/ContentRoomLifecycle');

type Handler = (...args: unknown[]) => void;

/**
 * A Socket.IO socket reduced to what room membership needs: the room set, the
 * listener table, and the connection flag the handler re-checks after its await.
 */
class FakeSocket {
  readonly id = 'socket-1';
  readonly rooms = new Set<string>();
  readonly handlers = new Map<string, Handler>();
  connected = true;
  user: { id: string } | undefined = { id: 'viewer-1' };
  handshake = { auth: { token: 'viewer-token' } };

  on(event: string, handler: Handler) {
    this.handlers.set(event, handler);
  }

  join(room: string) {
    this.rooms.add(room);
  }

  leave(room: string) {
    this.rooms.delete(room);
  }

  /** Deliver a client message to whatever the handler registered. */
  send(event: string, ...args: unknown[]) {
    const handler = this.handlers.get(event);
    if (!handler) throw new Error(`nothing is listening for "${event}"`);
    handler(...args);
  }
}

/** The real limiter's shape, with the limit itself out of the way. */
const passThroughLimiter = {
  wrap: <A extends unknown[]>(
    _socket: { id: string },
    _eventName: string,
    handler: (...args: A) => unknown,
  ) => (...args: A): void => {
    handler(...args);
  },
};

function setup(): FakeSocket {
  const socket = new FakeSocket();
  registerContentRoomHandlers(socket as unknown as Socket & { user?: { id: string } }, passThroughLimiter);
  return socket;
}

/** The handler joins after an await, so the assertion has to come after it too. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('post room membership', () => {
  beforeEach(() => {
    canViewerReadPostId.mockReset();
    createScopedOxyClient.mockClear();
  });

  it('joins the room for a post this viewer may read', async () => {
    canViewerReadPostId.mockResolvedValue(true);
    const socket = setup();

    socket.send('joinPost', '507f1f77bcf86cd799439011');
    await settle();

    expect(socket.rooms.has(postEngagementRoom('507f1f77bcf86cd799439011'))).toBe(true);
  });

  it('refuses a post this viewer may not read', async () => {
    canViewerReadPostId.mockResolvedValue(false);
    const socket = setup();

    socket.send('joinPost', 'someone-elses-private-post');
    await settle();

    expect(socket.rooms.size).toBe(0);
  });

  it('refuses when the visibility check cannot be answered', async () => {
    // Oxy is down, so the viewer's blocks and follows are unknown. An
    // unanswerable ACL is not a yes.
    canViewerReadPostId.mockRejectedValue(new Error('oxy unavailable'));
    const socket = setup();

    socket.send('joinPost', '507f1f77bcf86cd799439011');
    await settle();

    expect(socket.rooms.size).toBe(0);
  });

  it('asks nothing and joins nothing for an unauthenticated socket', async () => {
    canViewerReadPostId.mockResolvedValue(true);
    const socket = setup();
    socket.user = undefined;

    socket.send('joinPost', '507f1f77bcf86cd799439011');
    await settle();

    expect(canViewerReadPostId).not.toHaveBeenCalled();
    expect(socket.rooms.size).toBe(0);
  });

  it('does not join a socket that closed while the check was running', async () => {
    let release: (allowed: boolean) => void = () => undefined;
    canViewerReadPostId.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const socket = setup();

    socket.send('joinPost', '507f1f77bcf86cd799439011');
    socket.connected = false;
    release(true);
    await settle();

    expect(socket.rooms.size).toBe(0);
  });

  it('asks once when the same post is requested twice in flight', async () => {
    let release: (allowed: boolean) => void = () => undefined;
    canViewerReadPostId.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const socket = setup();

    socket.send('joinPost', '507f1f77bcf86cd799439011');
    socket.send('joinPost', '507f1f77bcf86cd799439011');
    release(true);
    await settle();

    expect(canViewerReadPostId).toHaveBeenCalledTimes(1);
  });

  it('leaves the room on unsubscribe', async () => {
    canViewerReadPostId.mockResolvedValue(true);
    const socket = setup();

    socket.send('joinPost', '507f1f77bcf86cd799439011');
    await settle();
    socket.send('leavePost', '507f1f77bcf86cd799439011');

    expect(socket.rooms.size).toBe(0);
  });

  it('does not land in a room the client already left', async () => {
    let release: (allowed: boolean) => void = () => undefined;
    canViewerReadPostId.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const socket = setup();

    // Open and close a post faster than the visibility check answers.
    socket.send('joinPost', '507f1f77bcf86cd799439011');
    socket.send('leavePost', '507f1f77bcf86cd799439011');
    release(true);
    await settle();

    expect(socket.rooms.size).toBe(0);
  });

  it('holds no more than the room ceiling, evicting the oldest', async () => {
    canViewerReadPostId.mockResolvedValue(true);
    const socket = setup();

    const ids = Array.from({ length: MAX_POST_ROOMS_PER_SOCKET + 3 }, (_, i) => `post-${i}`);
    for (const id of ids) {
      socket.send('joinPost', id);
      await settle();
    }

    expect(socket.rooms.size).toBe(MAX_POST_ROOMS_PER_SOCKET);
    expect(socket.rooms.has(postEngagementRoom('post-0'))).toBe(false);
    expect(socket.rooms.has(postEngagementRoom(ids[ids.length - 1]))).toBe(true);
  });

  it('ignores a room key that is not a string', async () => {
    canViewerReadPostId.mockResolvedValue(true);
    const socket = setup();

    socket.send('joinPost', { toString: () => 'evil' });
    socket.send('joinPost', '');
    await settle();

    expect(canViewerReadPostId).not.toHaveBeenCalled();
    expect(socket.rooms.size).toBe(0);
  });
});
