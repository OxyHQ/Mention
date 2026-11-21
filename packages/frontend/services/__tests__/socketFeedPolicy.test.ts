import { OxyServices } from '@oxy.so/core';
import { POST_ENGAGEMENT_EVENTS } from '@mention/shared-types/realtime';
const mockGetFeed = jest.fn();
const mockAddPosts = jest.fn();
const mockRefreshObservedRooms = jest.fn();
const mockHandlers = new Map<string, (value?: unknown) => void>();
const mockManagerHandlers = new Map<string, (...args: unknown[]) => void>();
const mockSocket = {
  active: true,
  connected: true,
  on: (event: string, handler: (value?: unknown) => void) => mockHandlers.set(event, handler),
  off: (event: string) => mockHandlers.delete(event),
  emit: jest.fn(),
  disconnect: jest.fn(),
  connect: jest.fn(),
  io: {
    on: jest.fn((event: string, handler: (...args: unknown[]) => void) =>
      mockManagerHandlers.set(event, handler),
    ),
    off: jest.fn((event: string) => mockManagerHandlers.delete(event)),
    reconnection: jest.fn(),
  },
};
// Posts refer to the Oxy SDK's `User`; the real one, without the SDK's UI barrel.
jest.mock('@oxy.so/services/ui/client', () => jest.requireActual('@/test-support/oxyUsers'));
jest.mock('socket.io-client', () => ({ io: () => mockSocket }));
// The home feed is held; a broadcast's refresh goes on top of it.
jest.mock('@/data/feeds', () => ({
  Feed: { get: () => ({ ids: [] }) },
  feedKey: () => 'feed',
  prependBroadcastPosts: (...args: unknown[]) => mockAddPosts(...args),
}));
jest.mock('@/stores/liveRoomsStore', () => ({
  useLiveRoomsStore: { getState: () => ({ refreshObservedLiveRooms: mockRefreshObservedRooms }) },
}));
jest.mock('../feedService', () => ({
  feedService: { getFeed: (...args: unknown[]) => mockGetFeed(...args) },
}));
jest.mock('@/db/feedItem', () => ({ toFeedItem: (value: unknown) => value }));
import { setActiveStore, Store } from '@oxy.so/bloom-data';
import { getPost, Post } from '@/data/posts';
import type { FeedItem } from '@/db/schema';
import { socketService } from '../socketService';
let mockOxy: OxyServices;
const socketToken = (userId: string) =>
  `e30.${Buffer.from(JSON.stringify({ userId, sessionId: userId, exp: 2000000000 })).toString('base64url')}.fixture`;

function signal(payload: unknown = { type: 'for_you' }) {
  const handler = mockHandlers.get('feed:updated');
  if (!handler) throw new Error('missing live socket listener');
  handler(payload);
}
async function flush() {
  jest.advanceTimersByTime(500);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
describe('feed broadcasts carry invalidation, not content authority', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockGetFeed.mockResolvedValue({
      items: [{ id: 'allowed', content: { text: 'Authorized body' } }],
    });
    mockOxy = new OxyServices({ baseURL: 'http://localhost:4110' });
    mockOxy.session.setAccessToken(socketToken('viewer-a'));
    socketService.connect('viewer-a', mockOxy);
  });
  afterEach(() => {
    socketService.disconnect();
    mockOxy.dispose();
    jest.useRealTimers();
  });
  it('reuses the manager for the same verified owner and epoch', () => {
    const calls = mockSocket.connect.mock.calls.length;
    socketService.connect('viewer-a', mockOxy);
    expect(mockSocket.connect).toHaveBeenCalledTimes(calls);
    expect(mockSocket.disconnect).not.toHaveBeenCalled();
  });
  it('coalesces a burst and inserts only the authenticated response', async () => {
    signal({
      type: 'for_you',
      post: { id: 'forged', content: { text: 'Unreviewed broadcast body' } },
    });
    signal();
    signal();
    expect(mockAddPosts).not.toHaveBeenCalled();
    await flush();
    expect(mockGetFeed).toHaveBeenCalledTimes(1);
    expect(mockGetFeed).toHaveBeenCalledWith({ type: 'for_you', limit: 50 });
    expect(mockAddPosts).toHaveBeenCalledWith('for_you', [
      { id: 'allowed', content: { text: 'Authorized body' } },
    ]);
    expect(JSON.stringify(mockAddPosts.mock.calls)).not.toContain('Unreviewed');
  });
  it('never inserts a response after switching accounts', async () => {
    let finish: (value: unknown) => void = () => {
      throw new Error('request not started');
    };
    mockGetFeed.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    signal();
    await flush();
    mockOxy.session.setAccessToken(socketToken('viewer-b'));
    socketService.connect('viewer-b', mockOxy);
    finish({ items: [{ id: 'private-to-a' }] });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockAddPosts).not.toHaveBeenCalled();
  });
  it('does not fall back to broadcast content on access failure', async () => {
    mockGetFeed.mockRejectedValueOnce(new Error('Policy unavailable'));
    signal({ type: 'for_you', post: { id: 'unavailable' } });
    await flush();
    expect(mockAddPosts).not.toHaveBeenCalled();
  });
  it('coalesces room signals and delegates to the observed-only refresh', async () => {
    const roomSignal = mockHandlers.get('rooms:live:updated');
    expect(roomSignal).toBeDefined();
    roomSignal?.();
    roomSignal?.();
    roomSignal?.();
    expect(mockRefreshObservedRooms).not.toHaveBeenCalled();
    await flush();
    expect(mockRefreshObservedRooms).toHaveBeenCalledTimes(1);
  });
});

describe('panel feed subscriptions share the transport', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockGetFeed.mockResolvedValue({ items: [] });
    mockOxy = new OxyServices({ baseURL: 'http://localhost:4110' });
    mockOxy.session.setAccessToken(socketToken('viewer-a'));
    socketService.connect('viewer-a', mockOxy);
  });
  afterEach(() => {
    socketService.disconnect();
    mockOxy.dispose();
    jest.useRealTimers();
  });
  it('delivers to both panels and unsubscribing one preserves the other and the personal room', () => {
    const first = jest.fn();
    const second = jest.fn();
    const stopFirst = socketService.subscribeToFeedUpdates('for_you', first);
    const stopSecond = socketService.subscribeToFeedUpdates('for_you', second);
    expect(
      mockSocket.emit.mock.calls.filter(
        ([event, payload]) => event === 'joinFeed' && payload.feedType === 'for_you',
      ),
    ).toHaveLength(1);
    signal();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    stopFirst();
    signal();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    stopSecond();
    signal();
    expect(second).toHaveBeenCalledTimes(2);
    expect(mockSocket.emit.mock.calls.filter(([event]) => event === 'leaveFeed')).toHaveLength(0);
  });
  it('rejects unknown rooms and refreshes supported subscriptions on reconnect', () => {
    const invalid = jest.fn();
    const live = jest.fn();
    const stopInvalid = socketService.subscribeToFeedUpdates('user:someone-else', invalid);
    const stopLive = socketService.subscribeToFeedUpdates('explore', live);
    mockHandlers.get('connect')?.();
    expect(live).toHaveBeenCalledTimes(1);
    expect(invalid).not.toHaveBeenCalled();
    expect(
      mockSocket.emit.mock.calls.some(([, payload]) => payload?.feedType === 'user:someone-else'),
    ).toBe(false);
    stopInvalid();
    stopLive();
  });
});

/** A held post with no likes yet. */
function seed(id: string): void {
  Post.put({ id, engagement: { likes: 0 }, viewerState: {} } as unknown as FeedItem);
}

describe('live counts across session changes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setActiveStore(new Store());
    seed('old-post');
    mockOxy = new OxyServices({ baseURL: 'http://localhost:4110' });
    mockOxy.session.setAccessToken(socketToken('viewer-a'));
    socketService.connect('viewer-a', mockOxy);
  });
  afterEach(() => {
    socketService.disconnect();
    mockOxy.dispose();
    jest.useRealTimers();
  });

  it('ignores callbacks retained by the old socket after A→B→A', async () => {
    jest.useFakeTimers();
    const oldConnect = mockHandlers.get('connect');
    const oldLiked = mockHandlers.get(POST_ENGAGEMENT_EVENTS.LIKED);
    expect(oldConnect).toBeDefined();
    expect(oldLiked).toBeDefined();
    mockOxy.session.setAccessToken(socketToken('viewer-b'));
    socketService.connect('viewer-b', mockOxy);
    mockOxy.session.setAccessToken(socketToken('viewer-a'));
    socketService.connect('viewer-a', mockOxy);
    oldConnect?.();
    oldLiked?.({ postId: 'old-post', actorId: 'other-user', likesCount: 3 });
    jest.advanceTimersByTime(300);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(getPost('old-post')?.engagement.likes).toBe(0);
  });

  it('does not deliver an old presence event to the new session listener', () => {
    const oldPresence = mockHandlers.get('user:presence');
    const listener = jest.fn();
    const stopOld = socketService.subscribeToPresence('friend', listener);
    mockOxy.session.setAccessToken(socketToken('viewer-b'));
    socketService.connect('viewer-b', mockOxy);
    socketService.subscribeToPresence('friend', listener);
    stopOld();
    oldPresence?.({ userId: 'friend', online: true });
    expect(listener).not.toHaveBeenCalled();
    mockHandlers.get('user:presence')?.({ userId: 'friend', online: true });
    expect(listener).toHaveBeenCalledWith(true);
  });

  it('ignores old disconnect and manager callbacks after replacing the socket', () => {
    const oldDisconnect = mockHandlers.get('disconnect');
    const oldFailure = mockManagerHandlers.get('reconnect_failed');
    const oldAttempt = mockManagerHandlers.get('reconnect_attempt');
    mockOxy.session.setAccessToken(socketToken('viewer-b'));
    socketService.connect('viewer-b', mockOxy);
    mockHandlers.get('connect')?.();
    oldDisconnect?.();
    oldFailure?.();
    oldAttempt?.(9);
    expect(socketService.getConnectionStatus()).toMatchObject({
      isConnected: true,
      reconnectAttempts: 0,
    });
    mockManagerHandlers.get('reconnect_attempt')?.(3);
    expect(socketService.getConnectionStatus().reconnectAttempts).toBe(3);
  });

  it('applies a burst once, with the newest count standing', () => {
    jest.useFakeTimers();
    let wakes = 0;
    const store = new Store();
    setActiveStore(store);
    seed('popular-post');
    store.listen(store.slot(Post.definition, 'popular-post', true), () => {
      wakes += 1;
    });
    for (let likesCount = 1; likesCount <= 101; likesCount++) {
      mockHandlers.get(POST_ENGAGEMENT_EVENTS.LIKED)?.({
        postId: 'popular-post',
        actorId: 'other',
        likesCount,
      });
    }
    jest.advanceTimersByTime(200);
    expect(wakes).toBe(1);
    expect(getPost('popular-post')?.engagement.likes).toBe(101);
  });

  it('rejects an old presence acknowledgement after a session switch', async () => {
    const pending = socketService.getPresence('friend');
    const call = mockSocket.emit.mock.calls.find(([event]) => event === 'getPresence');
    const acknowledge = call?.[2];
    expect(acknowledge).toEqual(expect.any(Function));
    mockOxy.session.setAccessToken(socketToken('viewer-b'));
    socketService.connect('viewer-b', mockOxy);
    acknowledge({ online: true });
    await expect(pending).rejects.toThrow('Socket session changed');
  });
});
