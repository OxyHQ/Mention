/**
 * The socket → store hop, executed rather than read.
 *
 * Everything between the wire and the rendered data is REAL here: the real
 * `publicRealtimeService`, the real `trendsStore`, the real handler wiring. Only
 * two things are doubled — `socket.io-client`, so a broadcast can be delivered
 * without a server, and `api`, so the refetch it triggers is observable. The
 * assertions land on STORE STATE, not on a spy handed to the code under test,
 * so a handler that stops calling `fetchTrends` fails them.
 */

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { removeItem: () => Promise.resolve() },
}));

jest.mock('@/utils/api', () => ({ api: { get: jest.fn() } }));

type MockHandler = (payload?: unknown) => void;

/** A stand-in for one Socket.IO socket, recording what the service listens to. */
class MockSocket {
  readonly handlers = new Map<string, MockHandler>();
  readonly managerHandlers = new Map<string, MockHandler>();
  connected = true;
  active = false;
  disconnectCalls = 0;
  connectCalls = 0;
  /** Every value passed to the Manager's `reconnection()`, in order. */
  readonly reconnectionSettings: boolean[] = [];

  readonly io = {
    on: (event: string, handler: MockHandler) => {
      this.managerHandlers.set(event, handler);
    },
    off: (event: string) => {
      this.managerHandlers.delete(event);
    },
    reconnection: (value: boolean) => {
      this.reconnectionSettings.push(value);
    },
  };

  on(event: string, handler: MockHandler) {
    this.handlers.set(event, handler);
  }

  off(event: string) {
    this.handlers.delete(event);
  }

  disconnect() {
    this.disconnectCalls += 1;
    this.connected = false;
  }

  connect() {
    this.connectCalls += 1;
    this.connected = true;
  }

  /** Deliver a server broadcast to whatever the service registered. */
  emitFromServer(event: string, payload?: unknown) {
    const handler = this.handlers.get(event);
    if (!handler) throw new Error(`nothing is listening for "${event}"`);
    handler(payload);
  }

  /** Fire the Manager's `reconnect`, as a real re-connection would. */
  emitReconnect() {
    const handler = this.managerHandlers.get('reconnect');
    if (!handler) throw new Error('nothing is listening for manager "reconnect"');
    handler();
  }
}

const mockIoCalls: Array<{ url: string; opts: Record<string, unknown> }> = [];
const mockSockets: MockSocket[] = [];

jest.mock('socket.io-client', () => ({
  io: (url: string, opts: Record<string, unknown>) => {
    mockIoCalls.push({ url, opts });
    const socket = new MockSocket();
    mockSockets.push(socket);
    return socket;
  },
}));

import { api } from '@/utils/api';
import { publicRealtimeService } from '@/services/publicRealtimeService';
import { useTrendsStore } from '@/stores/trendsStore';
import {
  PUBLIC_REALTIME_EVENTS,
  PUBLIC_REALTIME_NAMESPACE,
} from '@mention/shared-types';

const mockApiGet = api.get as jest.Mock;

/** The socket the service is currently holding. */
function liveSocket(): MockSocket {
  const socket = mockSockets.at(-1);
  if (!socket) throw new Error('the service never opened a socket');
  return socket;
}

/** One trend as `GET /trending` serves it. */
function trend(name: string, volume: number, series?: number[]) {
  return {
    _id: name,
    name,
    type: 'hashtag',
    score: 10,
    volume,
    momentum: 0.5,
    rank: 1,
    calculatedAt: '2026-07-29T06:00:00.000Z',
    ...(series ? { series } : {}),
  };
}

function respond(trending: unknown[], recId: string) {
  mockApiGet.mockResolvedValueOnce({ data: { trending, summary: '', recId } });
}

/** Let the store's `await api.get(...)` and its continuation settle. */
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  publicRealtimeService.disconnect();
  mockIoCalls.length = 0;
  mockSockets.length = 0;
  mockApiGet.mockReset();
  useTrendsStore.getState().resetViewerState();
});

afterAll(() => {
  publicRealtimeService.disconnect();
});

describe('public realtime transport', () => {
  it('connects to the public namespace with NO credentials', () => {
    publicRealtimeService.connect();

    expect(mockIoCalls).toHaveLength(1);
    expect(mockIoCalls[0].url).toBe(`ws://localhost:4110${PUBLIC_REALTIME_NAMESPACE}`);
    // The whole point of this connection: a signed-out visitor can open it.
    // Anything token-shaped here would mean it needs a session after all.
    expect(mockIoCalls[0].opts).not.toHaveProperty('auth');
    expect(mockIoCalls[0].opts).not.toHaveProperty('query');
    expect(mockIoCalls[0].opts.reconnection).toBe(true);
  });

  it('does not open a second Manager while one is already active', () => {
    publicRealtimeService.connect();
    liveSocket().active = true;
    publicRealtimeService.connect();

    expect(mockIoCalls).toHaveLength(1);
  });
});

describe('trends:updated → trendsStore', () => {
  it('advances the rendered series when the server publishes a new batch', async () => {
    publicRealtimeService.connect();

    respond([trend('tech', 40, [1, 2, 3, 4, 5, 6])], 'batch-1');
    await useTrendsStore.getState().fetchTrends();
    expect(useTrendsStore.getState().trends[0].series).toEqual([1, 2, 3, 4, 5, 6]);

    // A batch lands server-side and the notice arrives on the wire.
    respond([trend('tech', 55, [2, 3, 4, 5, 6, 7])], 'batch-2');
    liveSocket().emitFromServer(PUBLIC_REALTIME_EVENTS.TRENDS_UPDATED, {
      calculatedAt: '2026-07-29T06:30:00.000Z',
    });
    await settle();

    // The store — not a spy — holds the new batch. This is the hop.
    expect(useTrendsStore.getState().trends[0].series).toEqual([2, 3, 4, 5, 6, 7]);
    expect(useTrendsStore.getState().trends[0].volume).toBe(55);
    expect(mockApiGet).toHaveBeenNthCalledWith(2, '/trending', { limit: 10 });
  });

  it('refetches silently — a push never flashes the list back to a spinner', async () => {
    publicRealtimeService.connect();
    respond([trend('tech', 40)], 'batch-1');
    await useTrendsStore.getState().fetchTrends();

    respond([trend('tech', 55)], 'batch-2');
    liveSocket().emitFromServer(PUBLIC_REALTIME_EVENTS.TRENDS_UPDATED, {});

    expect(useTrendsStore.getState().isLoading).toBe(false);
  });

  it('stops listening once disconnected', () => {
    publicRealtimeService.connect();
    const socket = liveSocket();
    publicRealtimeService.disconnect();

    expect(socket.disconnectCalls).toBe(1);
    expect(() =>
      socket.emitFromServer(PUBLIC_REALTIME_EVENTS.TRENDS_UPDATED, {}),
    ).toThrow(/nothing is listening/);
  });
});

describe('reconnect resync', () => {
  it('refetches the WHOLE list after a reconnection, never appending', async () => {
    publicRealtimeService.connect();
    respond([trend('tech', 40, [1, 2, 3, 4, 5, 6])], 'batch-1');
    await useTrendsStore.getState().fetchTrends();

    // The client slept through five batches; the server's current series shares
    // no points with the one on screen. A delta path would leave a gap here.
    respond([trend('tech', 90, [11, 12, 13, 14, 15, 16])], 'batch-7');
    liveSocket().emitReconnect();
    await settle();

    expect(useTrendsStore.getState().trends[0].series).toEqual([11, 12, 13, 14, 15, 16]);
  });

  it('issues no request for a client that has never rendered a trend', () => {
    publicRealtimeService.connect();
    liveSocket().emitReconnect();

    expect(mockApiGet).not.toHaveBeenCalled();
  });
});

/**
 * An open WebSocket makes the whole document ineligible for the browser's
 * back/forward cache, which is what turns a cross-document Back into a full app
 * reload. `lib/socketBfcache.web.ts` drives this pair from `pagehide`/`pageshow`.
 */
describe('back/forward-cache freeze and restore', () => {
  it('suppresses reconnection rather than only closing the socket', () => {
    publicRealtimeService.connect();
    const socket = liveSocket();

    publicRealtimeService.suspendForPageFreeze();

    expect(socket.disconnectCalls).toBe(1);
    // Without this the Manager reopens the transport within a second and the
    // page is refused the cache again, before the traversal even happens.
    expect(socket.reconnectionSettings).toEqual([false]);
  });

  it('keeps the socket and its listeners, unlike a disconnect', () => {
    publicRealtimeService.connect();
    const socket = liveSocket();

    publicRealtimeService.suspendForPageFreeze();
    publicRealtimeService.resumeAfterPageRestore();

    // The same Socket, reopened — not a replacement. A second `io()` call here
    // would mean the frozen page lost its listeners and had to renegotiate.
    expect(mockIoCalls).toHaveLength(1);
    expect(socket.connectCalls).toBe(1);
    expect(socket.reconnectionSettings).toEqual([false, true]);
    expect(socket.handlers.has(PUBLIC_REALTIME_EVENTS.TRENDS_UPDATED)).toBe(true);
  });

  it('refetches the whole list on restore, having slept through every batch', async () => {
    publicRealtimeService.connect();
    respond([trend('tech', 40, [1, 2, 3, 4, 5, 6])], 'batch-1');
    await useTrendsStore.getState().fetchTrends();

    // Reopening by hand is not a Manager `reconnect`, so the handler bound to
    // that event never fires on this path — without its own resync the restored
    // page would show however stale a chart it was frozen with.
    respond([trend('tech', 90, [11, 12, 13, 14, 15, 16])], 'batch-7');
    publicRealtimeService.suspendForPageFreeze();
    publicRealtimeService.resumeAfterPageRestore();
    await settle();

    expect(useTrendsStore.getState().trends[0].series).toEqual([11, 12, 13, 14, 15, 16]);
  });

  it('does nothing on a restore it was never frozen for', () => {
    publicRealtimeService.connect();
    const socket = liveSocket();

    publicRealtimeService.resumeAfterPageRestore();

    // A `pageshow` that follows no freeze must not touch a live connection.
    expect(socket.connectCalls).toBe(0);
    expect(socket.reconnectionSettings).toEqual([]);
  });
});
