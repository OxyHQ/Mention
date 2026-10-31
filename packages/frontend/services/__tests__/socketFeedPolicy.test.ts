import { OxyServices } from '@oxy.so/core';
import { POST_ENGAGEMENT_EVENTS } from '@mention/shared-types/realtime';
import { engagementQueueStorageKey } from '../engagementQueuePersistence';
const mockGetFeed = jest.fn();
const mockAddPosts = jest.fn();
const mockUpdatePost = jest.fn();
const mockStorageGet = jest.fn();
const mockStorageSet = jest.fn();
const mockStorageRemove = jest.fn();
const mockRefreshObservedRooms = jest.fn();
const mockState = {
  feedUI: { for_you: { isLoading: false } },
  addPostsToFeed: mockAddPosts,
  updatePostEverywhere: mockUpdatePost,
};
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
jest.mock('socket.io-client', () => ({ io: () => mockSocket }));
jest.mock('@/stores/postsStore', () => ({
  usePostsStore: { getState: () => mockState, subscribe: () => () => {} },
}));
jest.mock('@/stores/liveRoomsStore', () => ({
  useLiveRoomsStore: { getState: () => ({ refreshObservedLiveRooms: mockRefreshObservedRooms }) },
}));
jest.mock('../feedService', () => ({
  feedService: { getFeed: (...args: unknown[]) => mockGetFeed(...args) },
}));
jest.mock('@/db/feedItem', () => ({ toFeedItem: (value: unknown) => value }));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: (...args: unknown[]) => mockStorageGet(...args),
    setItem: (...args: unknown[]) => mockStorageSet(...args),
    removeItem: (...args: unknown[]) => mockStorageRemove(...args),
  },
}));
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
    mockStorageGet.mockResolvedValue(null);
    mockStorageSet.mockResolvedValue(undefined);
    mockStorageRemove.mockResolvedValue(undefined);
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
    expect(mockAddPosts).toHaveBeenCalledWith(
      [{ id: 'allowed', content: { text: 'Authorized body' } }],
      'for_you',
    );
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
    mockStorageGet.mockResolvedValue(null);
    mockStorageSet.mockResolvedValue(undefined);
    mockStorageRemove.mockResolvedValue(undefined);
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

describe('engagement queue across session changes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStorageGet.mockResolvedValue(null);
    mockStorageSet.mockResolvedValue(undefined);
    mockStorageRemove.mockResolvedValue(undefined);
    mockOxy = new OxyServices({ baseURL: 'http://localhost:4110' });
    mockOxy.session.setAccessToken(socketToken('viewer-a'));
    socketService.connect('viewer-a', mockOxy);
  });
  afterEach(() => {
    socketService.disconnect();
    mockOxy.dispose();
    jest.useRealTimers();
  });

  it('replays a valid queue in the session that started its read', async () => {
    mockStorageGet.mockResolvedValueOnce(
      JSON.stringify({
        version: 2,
        viewerId: 'viewer-a',
        updates: { 'saved-post': [{ counts: { likes: 12 }, timestamp: 123 }] },
      }),
    );
    mockHandlers.get('connect')?.();
    for (let i = 0; i < 30 && !mockUpdatePost.mock.calls.length; i++) await Promise.resolve();
    expect(mockUpdatePost).toHaveBeenCalledWith('saved-post', expect.any(Function));
  });

  it('coalesces repeated reconnects during a held read and permits a later read', async () => {
    let finish!: (value: null) => void;
    mockStorageGet.mockReturnValueOnce(
      new Promise<null>((resolve) => {
        finish = resolve;
      }),
    );
    for (let i = 0; i < 10; i++) mockHandlers.get('connect')?.();
    for (let i = 0; i < 30 && !mockStorageGet.mock.calls.length; i++) await Promise.resolve();
    expect(mockStorageGet).toHaveBeenCalledTimes(1);
    finish(null);
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(mockStorageGet).toHaveBeenCalledTimes(1);
    mockHandlers.get('connect')?.();
    for (let i = 0; i < 30 && mockStorageGet.mock.calls.length < 2; i++) await Promise.resolve();
    expect(mockStorageGet).toHaveBeenCalledTimes(2);
  });

  it('permits a new replay after a storage read rejects', async () => {
    mockStorageGet.mockRejectedValueOnce(new Error('storage unavailable'));
    mockHandlers.get('connect')?.();
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(mockStorageGet).toHaveBeenCalledTimes(1);
    mockHandlers.get('connect')?.();
    for (let i = 0; i < 30 && mockStorageGet.mock.calls.length < 2; i++) await Promise.resolve();
    expect(mockStorageGet).toHaveBeenCalledTimes(2);
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
    expect(mockStorageGet).not.toHaveBeenCalled();
    expect(mockUpdatePost).not.toHaveBeenCalled();
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

  it('keeps the newest event when a post queue reaches its cap', () => {
    jest.useFakeTimers();
    for (let likesCount = 1; likesCount <= 101; likesCount++) {
      mockHandlers.get(POST_ENGAGEMENT_EVENTS.LIKED)?.({
        postId: 'popular-post',
        actorId: 'other',
        likesCount,
      });
    }
    jest.advanceTimersByTime(200);
    expect(mockUpdatePost).toHaveBeenCalledTimes(1);
    const updater = mockUpdatePost.mock.calls[0]?.[1];
    expect(updater({ engagement: { likes: 0 } }).engagement.likes).toBe(101);
  });

  it('coalesces many pending writes to the latest snapshot while storage is held', async () => {
    jest.useFakeTimers();
    let finishWrite!: () => void;
    mockStorageSet.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishWrite = resolve;
      }),
    );
    for (let likesCount = 1; likesCount <= 30; likesCount++) {
      mockHandlers.get(POST_ENGAGEMENT_EVENTS.LIKED)?.({
        postId: 'post',
        actorId: 'other',
        likesCount,
      });
      jest.advanceTimersByTime(50);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    expect(mockStorageSet).toHaveBeenCalledTimes(1);
    finishWrite();
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(mockStorageSet).toHaveBeenCalledTimes(2);
    const latest = JSON.parse(mockStorageSet.mock.calls[1][1]);
    expect(latest.updates.post.at(-1).counts.likes).toBe(30);
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

  it.each([false, true])(
    'keeps live counts when a persisted read finishes (already processed: %s)',
    async (processed) => {
      jest.useFakeTimers();
      let finishRead!: (value: string) => void;
      mockStorageGet.mockReturnValueOnce(
        new Promise<string>((resolve) => {
          finishRead = resolve;
        }),
      );
      let engagement = { likes: 0, boosts: 0 };
      mockUpdatePost.mockImplementation((_postId, update) => {
        engagement = update({ engagement }).engagement;
      });
      mockHandlers.get('connect')?.();
      for (let i = 0; i < 30 && !mockStorageGet.mock.calls.length; i++) await Promise.resolve();
      expect(mockStorageGet).toHaveBeenCalled();
      mockHandlers.get(POST_ENGAGEMENT_EVENTS.LIKED)?.({
        postId: 'post',
        actorId: 'other',
        likesCount: 10,
      });
      if (processed) jest.advanceTimersByTime(200);
      finishRead(
        JSON.stringify({
          version: 2,
          viewerId: 'viewer-a',
          updates: { post: [{ counts: { likes: 5, boosts: 7 }, timestamp: 123 }] },
        }),
      );
      for (let i = 0; i < 40; i++) await Promise.resolve();
      expect(engagement).toEqual({ likes: 10, boosts: 7 });
      mockUpdatePost.mockReset();
    },
  );

  it('keeps a queued live count received before reconnect even if it flushes during storage read', async () => {
    jest.useFakeTimers();
    let finishRead!: (value: string) => void;
    mockStorageGet.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finishRead = resolve;
      }),
    );
    let engagement = { likes: 0, boosts: 0 };
    mockUpdatePost.mockImplementation((_postId, update) => {
      engagement = update({ engagement }).engagement;
    });
    mockHandlers.get(POST_ENGAGEMENT_EVENTS.LIKED)?.({
      postId: 'post',
      actorId: 'other',
      likesCount: 10,
    });
    mockHandlers.get('connect')?.();
    for (let i = 0; i < 30 && !mockStorageGet.mock.calls.length; i++) await Promise.resolve();
    expect(mockStorageGet).toHaveBeenCalled();
    jest.advanceTimersByTime(200);
    finishRead(
      JSON.stringify({
        version: 2,
        viewerId: 'viewer-a',
        updates: { post: [{ counts: { likes: 5, boosts: 7 }, timestamp: 123 }] },
      }),
    );
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(engagement).toEqual({ likes: 10, boosts: 7 });
    mockUpdatePost.mockReset();
  });

  it('does not replay an old queue when account cleanup fails', async () => {
    const keyA = engagementQueueStorageKey('viewer-a');
    mockStorageRemove.mockImplementation((key: string) =>
      key === keyA ? Promise.reject(new Error('storage unavailable')) : Promise.resolve(),
    );
    mockStorageGet.mockResolvedValue(
      JSON.stringify({
        version: 2,
        viewerId: 'viewer-a',
        updates: { 'old-post': [{ counts: { likes: 12 }, timestamp: 123 }] },
      }),
    );
    mockOxy.session.setAccessToken(socketToken('viewer-b'));
    socketService.connect('viewer-b', mockOxy);
    mockOxy.session.setAccessToken(socketToken('viewer-a'));
    socketService.connect('viewer-a', mockOxy);
    mockHandlers.get('connect')?.();
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(mockStorageGet).not.toHaveBeenCalledWith(keyA);
    expect(mockUpdatePost).not.toHaveBeenCalled();
    mockStorageRemove.mockResolvedValue(undefined);
  });

  it('removes a pending A write before a new A session reads while B stays independent', async () => {
    jest.useFakeTimers();
    let finishWrite!: () => void;
    mockStorageSet.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishWrite = resolve;
      }),
    );
    mockHandlers.get(POST_ENGAGEMENT_EVENTS.LIKED)?.({
      postId: 'pending-post',
      actorId: 'another-user',
      likesCount: 3,
    });
    jest.advanceTimersByTime(50);
    for (let i = 0; i < 30 && !mockStorageSet.mock.calls.length; i++) await Promise.resolve();
    expect(mockStorageSet).toHaveBeenCalledWith(
      engagementQueueStorageKey('viewer-a'),
      expect.any(String),
    );

    mockOxy.session.setAccessToken(socketToken('viewer-b'));
    socketService.connect('viewer-b', mockOxy);
    mockHandlers.get('connect')?.();
    for (let i = 0; i < 30 && !mockStorageGet.mock.calls.length; i++) await Promise.resolve();
    expect(mockStorageGet).toHaveBeenCalledWith(engagementQueueStorageKey('viewer-b'));
    mockOxy.session.setAccessToken(socketToken('viewer-a'));
    socketService.connect('viewer-a', mockOxy);
    mockHandlers.get('connect')?.();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(mockStorageGet).not.toHaveBeenCalledWith(engagementQueueStorageKey('viewer-a'));
    finishWrite();
    for (let i = 0; i < 40; i++) await Promise.resolve();
    const removalIndex = mockStorageRemove.mock.calls.findIndex(
      ([key]) => key === engagementQueueStorageKey('viewer-a'),
    );
    const readIndex = mockStorageGet.mock.calls.findIndex(
      ([key]) => key === engagementQueueStorageKey('viewer-a'),
    );
    expect(removalIndex).toBeGreaterThanOrEqual(0);
    expect(readIndex).toBeGreaterThanOrEqual(0);
    expect(mockStorageRemove.mock.invocationCallOrder[removalIndex]).toBeLessThan(
      mockStorageGet.mock.invocationCallOrder[readIndex],
    );
  });

  it('does not replay an old A queue when its read resolves after A→B→A', async () => {
    let finish!: (value: string) => void;
    mockStorageGet.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    mockHandlers.get('connect')?.();
    for (let i = 0; i < 10 && !mockStorageGet.mock.calls.length; i++) await Promise.resolve();
    expect(mockStorageGet).toHaveBeenCalledTimes(1);
    mockOxy.session.setAccessToken(socketToken('viewer-b'));
    socketService.connect('viewer-b', mockOxy);
    mockOxy.session.setAccessToken(socketToken('viewer-a'));
    socketService.connect('viewer-a', mockOxy);
    mockHandlers.get('connect')?.();
    await Promise.resolve();
    await Promise.resolve();
    finish(
      JSON.stringify({
        version: 2,
        viewerId: 'viewer-a',
        updates: { 'old-post': [{ counts: { likes: 12 }, timestamp: 123 }] },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockUpdatePost).not.toHaveBeenCalled();
  });
});
