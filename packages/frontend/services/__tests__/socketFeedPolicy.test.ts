const mockGetFeed = jest.fn();
const mockAddPosts = jest.fn();
const mockState = { feedUI: { for_you: { isLoading: false } }, addPostsToFeed: mockAddPosts };
const mockHandlers = new Map<string, (value?: unknown) => void>();
const mockSocket = {
  active: true,
  connected: true,
  on: (event: string, handler: (value?: unknown) => void) => mockHandlers.set(event, handler),
  off: (event: string) => mockHandlers.delete(event),
  emit: jest.fn(),
  disconnect: jest.fn(),
  connect: jest.fn(),
  io: { on: jest.fn(), off: jest.fn(), reconnection: jest.fn() },
};
jest.mock('socket.io-client', () => ({ io: () => mockSocket }));
jest.mock('@/stores/postsStore', () => ({
  usePostsStore: { getState: () => mockState, subscribe: () => () => {} },
}));
jest.mock('@/stores/liveRoomsStore', () => ({
  useLiveRoomsStore: { getState: () => ({ fetchLiveRooms: jest.fn() }) },
}));
jest.mock('../feedService', () => ({
  feedService: { getFeed: (...args: unknown[]) => mockGetFeed(...args) },
}));
jest.mock('@/db/feedItem', () => ({ toFeedItem: (value: unknown) => value }));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
import { socketService } from '../socketService';
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
    socketService.connect('viewer-a', 'token-a');
  });
  afterEach(() => {
    socketService.disconnect();
    jest.useRealTimers();
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
    socketService.connect('viewer-b', 'token-b');
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
});
