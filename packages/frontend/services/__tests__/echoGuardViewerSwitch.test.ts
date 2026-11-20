import { OxyServices } from '@oxy.so/core';
import { POST_ENGAGEMENT_EVENTS } from '@mention/shared-types/realtime';
import { markLocalAction } from '../echoGuard';

const mockHandlers = new Map<string, (payload?: unknown) => void>();
const mockSocket = {
  active: true,
  connected: true,
  on: (event: string, handler: (payload?: unknown) => void) => mockHandlers.set(event, handler),
  off: (event: string) => mockHandlers.delete(event),
  emit: jest.fn(),
  disconnect: jest.fn(),
  connect: jest.fn(),
  io: { on: jest.fn(), off: jest.fn(), reconnection: jest.fn() },
};
jest.mock('socket.io-client', () => ({ io: () => mockSocket }));
jest.mock('@/data/feeds', () => ({
  Feed: { get: () => undefined },
  feedKey: () => 'feed',
  prependBroadcastPosts: jest.fn(),
}));
jest.mock('@/stores/liveRoomsStore', () => ({
  useLiveRoomsStore: { getState: () => ({ fetchLiveRooms: jest.fn() }) },
}));
jest.mock('../feedService', () => ({ feedService: {} }));
jest.mock('@/db/feedItem', () => ({ toFeedItem: (value: unknown) => value }));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
import { setActiveStore, Store } from '@oxy.so/bloom-data';
import { getPost, Post } from '@/data/posts';
import type { FeedItem } from '@/db/schema';
import { socketService } from '../socketService';

const token = (userId: string, sessionId = userId) =>
  `e30.${Buffer.from(JSON.stringify({ userId, sessionId, exp: 2000000000 })).toString('base64url')}.fixture`;

/** The likes and saves each post shows, as the shared posts hold them. */
const counts = (id: string) => getPost(id)?.engagement;

beforeEach(() => {
  setActiveStore(new Store());
  Post.put(
    ['own', 'other', 'post-1', 'post-2'].map(
      (id) => ({ id, engagement: { likes: 0, saves: 0 }, viewerState: {} }) as unknown as FeedItem,
    ),
  );
});

it('ignores known own actors and accepts known other actors despite a recent local action', () => {
  jest.useFakeTimers();
  const oxy = new OxyServices({ baseURL: 'http://localhost:4110' });
  oxy.session.setAccessToken(token('viewer-a'));
  socketService.connect('viewer-a', oxy);
  mockHandlers.get(POST_ENGAGEMENT_EVENTS.LIKED)?.({
    postId: 'own',
    actorId: 'viewer-a',
    likesCount: 1,
  });
  markLocalAction('other', 'like');
  mockHandlers.get(POST_ENGAGEMENT_EVENTS.LIKED)?.({
    postId: 'other',
    actorId: 'viewer-b',
    likesCount: 2,
  });
  jest.advanceTimersByTime(200);
  expect(counts('other')?.likes).toBe(2);
  expect(counts('own')?.likes).toBe(0);
  socketService.disconnect();
  oxy.dispose();
  jest.useRealTimers();
});

it('suppresses the current viewer echo but accepts the next viewer’s event', () => {
  jest.useFakeTimers();
  const oxy = new OxyServices({ baseURL: 'http://localhost:4110' });
  oxy.session.setAccessToken(token('viewer-a'));
  socketService.connect('viewer-a', oxy);
  markLocalAction('post-1', 'save');
  mockHandlers.get(POST_ENGAGEMENT_EVENTS.SAVED)?.({ postId: 'post-1', savesCount: 4 });
  jest.advanceTimersByTime(200);
  expect(counts('post-1')?.saves).toBe(0);

  oxy.session.setAccessToken(token('viewer-b'));
  socketService.connect('viewer-b', oxy);
  mockHandlers.get(POST_ENGAGEMENT_EVENTS.SAVED)?.({ postId: 'post-1', savesCount: 5 });
  jest.advanceTimersByTime(200);
  expect(counts('post-1')?.saves).toBe(5);
  socketService.disconnect();
  oxy.dispose();
  jest.useRealTimers();
});

it('forgets actions from a replaced session for the same account', () => {
  jest.useFakeTimers();
  const oxy = new OxyServices({ baseURL: 'http://localhost:4110' });
  oxy.session.setAccessToken(token('viewer-a'));
  socketService.connect('viewer-a', oxy);
  markLocalAction('post-2', 'save');
  oxy.session.setAccessToken(token('viewer-a', 'new-session'));
  socketService.connect('viewer-a', oxy);
  mockHandlers.get(POST_ENGAGEMENT_EVENTS.SAVED)?.({ postId: 'post-2', savesCount: 5 });
  jest.advanceTimersByTime(200);
  expect(counts('post-2')?.saves).toBe(5);
  socketService.disconnect();
  oxy.dispose();
  jest.useRealTimers();
});
