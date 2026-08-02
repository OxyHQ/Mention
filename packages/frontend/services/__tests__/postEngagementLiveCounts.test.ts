/**
 * Live post-engagement counts, executed end to end rather than asserted about.
 *
 * A real Socket.IO server, two real client connections over a real port, the
 * real `socketService` wiring and the real `postsStore`. The only double is
 * `@/db`, which stands in for SQLite — so every assertion here lands on the
 * post the app would render, not on a spy handed to the code under test.
 *
 * The server side plays the part the backend plays: it keys its room with the
 * SAME `postEngagementRoom` helper the backend uses and sends the SAME
 * `PostEngagementCountsPayload`, so a change to either breaks this file at
 * compile time. What it deliberately does NOT reproduce is the backend's
 * visibility check and its privacy-aware payload construction — those are real
 * code with their own tests in `packages/backend`; here they would be a copy,
 * and a copy cannot fail when the original does.
 */

import http from 'http';
import type { AddressInfo } from 'net';
import { Server as SocketIOServer, type Socket as ServerSocket } from 'socket.io';
import {
  POST_ENGAGEMENT_EVENTS,
  postEngagementRoom,
  type PostEngagementCountsPayload,
} from '@mention/shared-types';
import type { FeedItem } from '@/db';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: () => Promise.resolve(null),
    setItem: () => Promise.resolve(),
    removeItem: () => Promise.resolve(),
  },
}));

// The store reaches the network and SQLite through these; none of them is on
// the path a broadcast takes, and left real they drag the ESM-only Oxy SDK into
// a CommonJS jest run.
jest.mock('@/services/feedService', () => ({
  feedService: {
    getSavedPosts: jest.fn(),
    getUserFeed: jest.fn(),
    getPostById: jest.fn(),
  },
}));
jest.mock('@/lib/precacheActorsFromPosts', () => ({
  precacheActorsFromPosts: jest.fn(),
}));
jest.mock('@/stores/feedScrollStore', () => ({
  useFeedScrollStore: { getState: () => ({ retainSlice: jest.fn(), getSlice: () => null }) },
}));
jest.mock('@/stores/liveRoomsStore', () => ({
  useLiveRoomsStore: { getState: () => ({ fetchLiveRooms: jest.fn() }) },
}));

const mockPosts = new Map<string, FeedItem>();

jest.mock('@/db', () => ({
  upsertPost: jest.fn(),
  upsertPosts: jest.fn(),
  getPostById: (postId: string) => mockPosts.get(postId) ?? null,
  updatePost: (
    postId: string,
    updater: (previous: FeedItem) => FeedItem | null | undefined,
  ) => {
    const previous = mockPosts.get(postId);
    if (!previous) return null;
    const next = updater(previous);
    if (!next) return null;
    mockPosts.set(postId, next);
    return next;
  },
  deletePost: jest.fn(),
  pruneOldPosts: jest.fn(),
  setFeedItems: jest.fn(),
  appendFeedItems: jest.fn(),
  prependFeedItem: jest.fn(),
  addFeedItemAtStart: jest.fn(),
  removeFeedItem: jest.fn(),
  getFeedItems: () => [],
  getFeedMeta: () => null,
  clearFeed: jest.fn(),
  clearAllCachedData: jest.fn(),
  buildFeedKey: (type: string, userId?: string) => (userId ? `user:${userId}:${type}` : type),
  resolvePostId: (post: FeedItem) => post.id,
}));

const VIEWER_ID = 'viewer-a';
const OTHER_ACTOR_ID = 'actor-b';
const WATCHED_POST = 'post-watched';
const UNWATCHED_POST = 'post-unwatched';

/** A post as the store holds it, with the counters this suite moves. */
function seedPost(id: string, engagement: Partial<FeedItem['engagement']> = {}): void {
  mockPosts.set(id, {
    id,
    engagement: {
      likes: 10,
      downvotes: 0,
      boosts: 3,
      replies: 1,
      saves: 2,
      ...engagement,
    },
    viewerState: { isLiked: false, isBoosted: false, isSaved: false },
  } as unknown as FeedItem);
}

function storedPost(id: string): FeedItem {
  const post = mockPosts.get(id);
  if (!post) throw new Error(`no post "${id}" in the store`);
  return post;
}

/**
 * The engagement queue debounces for 200ms before touching the store, so every
 * assertion has to outlast that. Polling rather than sleeping keeps a slow CI
 * machine from being the reason a real convergence looks like a failure.
 */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('live post engagement counts, over a real socket', () => {
  let httpServer: http.Server;
  let ioServer: SocketIOServer;
  let serverSockets: ServerSocket[] = [];
  let joinedRooms: string[] = [];
  let socketService: typeof import('@/services/socketService').socketService;

  beforeAll(async () => {
    httpServer = http.createServer();
    ioServer = new SocketIOServer(httpServer, { transports: ['websocket'] });

    // Stands in for `registerContentRoomHandlers`. The room KEY is the shared
    // one; the admission decision is the backend's and is tested there.
    ioServer.on('connection', (socket) => {
      serverSockets.push(socket);
      socket.on('joinPost', (postId: string) => {
        joinedRooms.push(postId);
        socket.join(postEngagementRoom(postId));
      });
      socket.on('leavePost', (postId: string) => {
        socket.leave(postEngagementRoom(postId));
      });
    });

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address() as AddressInfo;

    // Read at module load, so the override has to land before the import.
    process.env.EXPO_PUBLIC_API_URL_SOCKET = `http://127.0.0.1:${port}`;
    jest.resetModules();
    socketService = require('@/services/socketService').socketService;
  });

  afterAll(async () => {
    socketService.dispose();
    ioServer.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  beforeEach(async () => {
    mockPosts.clear();
    joinedRooms = [];
    seedPost(WATCHED_POST);
    seedPost(UNWATCHED_POST);

    socketService.connect(VIEWER_ID, 'test-token');
    await waitFor(() => socketService.getConnectionStatus().isConnected, 'the socket to connect');

    socketService.joinPost(WATCHED_POST);
    await waitFor(() => joinedRooms.includes(WATCHED_POST), 'the server to see the join');
  });

  afterEach(() => {
    socketService.disconnect();
    serverSockets = [];
  });

  /** Everything a real broadcast is: one payload, into one post's room. */
  function broadcast(
    event: string,
    payload: Omit<PostEngagementCountsPayload, 'timestamp'>,
  ): void {
    ioServer
      .to(postEngagementRoom(payload.postId))
      .emit(event, { ...payload, timestamp: new Date().toISOString() });
  }

  it("converges on the server's number when somebody else likes the post", async () => {
    broadcast(POST_ENGAGEMENT_EVENTS.LIKED, {
      postId: WATCHED_POST,
      likesCount: 42,
      downvotesCount: 0,
      actorId: OTHER_ACTOR_ID,
    });

    await waitFor(
      () => storedPost(WATCHED_POST).engagement.likes === 42,
      "the watched post's like count to reach the server's 42",
    );
  });

  it('delivers nothing for a post this client never joined', async () => {
    broadcast(POST_ENGAGEMENT_EVENTS.LIKED, {
      postId: UNWATCHED_POST,
      likesCount: 999,
      actorId: OTHER_ACTOR_ID,
    });

    // The watched post is the control: once ITS event has landed, the unwatched
    // one has had at least as long to arrive and demonstrably did not.
    broadcast(POST_ENGAGEMENT_EVENTS.LIKED, {
      postId: WATCHED_POST,
      likesCount: 11,
      actorId: OTHER_ACTOR_ID,
    });
    await waitFor(
      () => storedPost(WATCHED_POST).engagement.likes === 11,
      'the control event to land',
    );

    expect(storedPost(UNWATCHED_POST).engagement.likes).toBe(10);
  });

  it("does not double-count this viewer's own like", async () => {
    // What the app does first: an optimistic +1 and the viewer's own flag. The
    // server's answer names the same total, because it is a total.
    mockPosts.set(WATCHED_POST, {
      ...storedPost(WATCHED_POST),
      engagement: { ...storedPost(WATCHED_POST).engagement, likes: 11 },
      viewerState: { ...storedPost(WATCHED_POST).viewerState, isLiked: true },
    } as FeedItem);

    broadcast(POST_ENGAGEMENT_EVENTS.LIKED, {
      postId: WATCHED_POST,
      likesCount: 11,
      actorId: VIEWER_ID,
    });

    // A second, unmistakably foreign event, so the wait cannot pass merely
    // because nothing has arrived yet.
    broadcast(POST_ENGAGEMENT_EVENTS.BOOSTED, {
      postId: WATCHED_POST,
      boostsCount: 4,
      actorId: OTHER_ACTOR_ID,
    });
    await waitFor(
      () => storedPost(WATCHED_POST).engagement.boosts === 4,
      'the foreign boost event to land',
    );

    // 12 would mean the event was read as "one more like" rather than as the
    // count itself — the failure this whole wire format exists to rule out.
    expect(storedPost(WATCHED_POST).engagement.likes).toBe(11);
    expect(storedPost(WATCHED_POST).viewerState.isLiked).toBe(true);
  });

  it("lets a newer local change outlive the echo of this viewer's own older one", async () => {
    // The viewer liked (optimistic 11) and immediately unliked (optimistic 10).
    // The LIKE's echo is still in flight and truthfully reports 11 — truthfully,
    // because at the moment the server wrote it that was the total.
    mockPosts.set(WATCHED_POST, {
      ...storedPost(WATCHED_POST),
      engagement: { ...storedPost(WATCHED_POST).engagement, likes: 10 },
    } as FeedItem);

    broadcast(POST_ENGAGEMENT_EVENTS.LIKED, {
      postId: WATCHED_POST,
      likesCount: 11,
      actorId: VIEWER_ID,
    });

    broadcast(POST_ENGAGEMENT_EVENTS.BOOSTED, {
      postId: WATCHED_POST,
      boostsCount: 4,
      actorId: OTHER_ACTOR_ID,
    });
    await waitFor(
      () => storedPost(WATCHED_POST).engagement.boosts === 4,
      'the foreign boost event to land',
    );

    // Applying the stale self-echo would flash 11 under the reader's own thumb
    // before the unlike's echo pulled it back. Recognising it as this viewer's
    // own is what avoids that; the unlike's echo carries the same actor and is
    // discarded for the same reason, leaving the optimistic value standing.
    expect(storedPost(WATCHED_POST).engagement.likes).toBe(10);
  });

  it('applies every counter in a batch, not just the last event', async () => {
    broadcast(POST_ENGAGEMENT_EVENTS.LIKED, {
      postId: WATCHED_POST,
      likesCount: 50,
      actorId: OTHER_ACTOR_ID,
    });
    broadcast(POST_ENGAGEMENT_EVENTS.BOOSTED, {
      postId: WATCHED_POST,
      boostsCount: 9,
      actorId: OTHER_ACTOR_ID,
    });
    broadcast(POST_ENGAGEMENT_EVENTS.REPLIED, {
      postId: WATCHED_POST,
      repliesCount: 7,
      actorId: OTHER_ACTOR_ID,
    });

    await waitFor(
      () => storedPost(WATCHED_POST).engagement.replies === 7,
      'the batched events to land',
    );
    expect(storedPost(WATCHED_POST).engagement.likes).toBe(50);
    expect(storedPost(WATCHED_POST).engagement.boosts).toBe(9);
  });

  it('takes the newest value within one batch, even when it is lower', async () => {
    // A like then an unlike, close enough together to share one debounce window,
    // so the merge — not the store — is what has to pick between them. Folding
    // to the OLDEST value would settle on 50 here.
    broadcast(POST_ENGAGEMENT_EVENTS.LIKED, {
      postId: WATCHED_POST,
      likesCount: 50,
      actorId: OTHER_ACTOR_ID,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    broadcast(POST_ENGAGEMENT_EVENTS.UNLIKED, {
      postId: WATCHED_POST,
      likesCount: 49,
      actorId: OTHER_ACTOR_ID,
    });

    await waitFor(
      () => storedPost(WATCHED_POST).engagement.likes === 49,
      'the newest like count in the batch to win',
    );
  });

  it('takes a later, lower value from a separate batch', async () => {
    // The same two events far enough apart to be applied one after the other —
    // the ordinary case of someone liking and then changing their mind. Nothing
    // may refuse a count for being smaller than the one already rendered: the
    // server's latest word is the count, and a guard that only ever let numbers
    // climb would freeze this post at 50 for as long as it stayed on screen.
    broadcast(POST_ENGAGEMENT_EVENTS.LIKED, {
      postId: WATCHED_POST,
      likesCount: 50,
      actorId: OTHER_ACTOR_ID,
    });
    await waitFor(
      () => storedPost(WATCHED_POST).engagement.likes === 50,
      'the first count to be applied on its own',
    );

    broadcast(POST_ENGAGEMENT_EVENTS.UNLIKED, {
      postId: WATCHED_POST,
      likesCount: 49,
      actorId: OTHER_ACTOR_ID,
    });
    await waitFor(
      () => storedPost(WATCHED_POST).engagement.likes === 49,
      'the later, lower count to replace it',
    );
  });

  it('leaves a counter the author hides exactly where it was', async () => {
    broadcast(POST_ENGAGEMENT_EVENTS.LIKED, {
      postId: WATCHED_POST,
      // No `likesCount`: this author hides it, so the number never travels.
      downvotesCount: 4,
      actorId: OTHER_ACTOR_ID,
    });

    await waitFor(
      () => storedPost(WATCHED_POST).engagement.downvotes === 4,
      'the visible counter to land',
    );
    expect(storedPost(WATCHED_POST).engagement.likes).toBe(10);
  });

  it("never lets another actor's event touch this viewer's own state", async () => {
    broadcast(POST_ENGAGEMENT_EVENTS.SAVED, {
      postId: WATCHED_POST,
      savesCount: 8,
      // Saves carry no actor, deliberately — a room must not learn who saved.
    });

    await waitFor(
      () => storedPost(WATCHED_POST).engagement.saves === 8,
      'the save count to land',
    );
    expect(storedPost(WATCHED_POST).viewerState.isSaved).toBe(false);
  });

  it('re-joins its post rooms after a reconnect', async () => {
    joinedRooms = [];

    // Drop the TRANSPORT, which is what a network blip or a load balancer
    // recycling a connection looks like — and the case Socket.IO reconnects
    // from. (A `socket.disconnect()` from the server would not: the client
    // treats that as deliberate and stays down, by design.) Room membership dies
    // with the connection either way, so the client has to say so again or the
    // counts silently stop.
    for (const socket of serverSockets) socket.conn.close();

    await waitFor(
      () => joinedRooms.includes(WATCHED_POST),
      'the client to re-assert its room after reconnecting',
    );
  });
});
