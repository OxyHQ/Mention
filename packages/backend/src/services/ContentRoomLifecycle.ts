import type { Socket } from 'socket.io';
import {
  POST_ENGAGEMENT_ROOM_PREFIX,
  postEngagementRoom,
} from '@mention/shared-types';
import { postHydrationService } from './PostHydrationService';
import { createScopedOxyClient } from '../utils/oxyHelpers';
import { logger } from '../utils/logger';

export interface AuthenticatedContentSocket extends Socket {
  user?: { id: string; [key: string]: unknown };
}

/** Rate-limited handler wrapper, as provided by `createSocketRateLimiter`. */
interface SocketRateLimiter {
  wrap<A extends unknown[]>(
    socket: { id: string },
    eventName: string,
    handler: (...args: A) => unknown,
  ): (...args: A) => void;
}

/**
 * How many post rooms one socket may occupy at once.
 *
 * The rate limiter caps how FAST a client can join (20 per 10s); without a
 * ceiling on the total, a client that keeps joining forever still accumulates
 * unbounded room membership on every task in the cluster. A reader is looking at
 * one post at a time, plus whatever a navigation stack left behind, so twenty is
 * far above real use and still a constant.
 *
 * At the ceiling the OLDEST room is dropped rather than the new join refused:
 * the room the user just opened is the one they are looking at, and a client
 * that leaked rooms (a crash between mount and unmount) then heals instead of
 * being locked out of live counts for the life of the connection.
 */
export const MAX_POST_ROOMS_PER_SOCKET = 20;

function joinedPostRooms(socket: Socket): string[] {
  return Array.from(socket.rooms).filter((room) =>
    room.startsWith(POST_ENGAGEMENT_ROOM_PREFIX),
  );
}

/**
 * Subscribe this socket to one post's live engagement counters.
 *
 * The post id comes from the client, so membership is decided by the server's
 * own read ACL — `canViewerReadPostId`, the same gate that decides whether the
 * post may be rendered for this viewer at all. Anything the room later carries
 * is therefore something this viewer could already have read over HTTP.
 *
 * Fails CLOSED. The gate needs the viewer's blocks and follow graph from Oxy, so
 * an Oxy outage makes the question unanswerable — and an unanswerable ACL is not
 * a yes. The cost of refusing is that counts stop updating live during an
 * outage; the cost of allowing would be a subscription nobody checked.
 */
async function joinPostRoom(
  socket: AuthenticatedContentSocket,
  postId: string,
  stillWanted: () => boolean,
): Promise<void> {
  const viewerId = socket.user?.id;
  if (!viewerId) return;

  const room = postEngagementRoom(postId);
  if (socket.rooms.has(room)) return;

  let allowed = false;
  try {
    allowed = await postHydrationService.canViewerReadPostId(postId, viewerId, {
      // The socket carries the same bearer the HTTP client uses; the viewer's
      // block and restriction lists are readable only under their own identity.
      oxyClient: createScopedOxyClient({ accessToken: readHandshakeToken(socket) }),
    });
  } catch (error) {
    logger.warn('Refusing post room join: visibility check failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  // The ACL is a round trip, and three things can change under it: the answer
  // can be no, the client can have closed (joining a dead socket leaves a room
  // entry the adapter never reaps), or the client can have navigated away and
  // already sent `leavePost` for this very post — a leave that arrives while the
  // check is running has nothing to remove yet, so it has to be honoured here or
  // the viewer ends up subscribed to a post they closed.
  if (!allowed || !socket.connected || !stillWanted()) return;

  const occupied = joinedPostRooms(socket);
  if (occupied.length >= MAX_POST_ROOMS_PER_SOCKET) {
    for (const stale of occupied.slice(0, occupied.length - MAX_POST_ROOMS_PER_SOCKET + 1)) {
      socket.leave(stale);
    }
  }

  socket.join(room);
}

function readHandshakeToken(socket: Socket): string | undefined {
  const token = socket.handshake?.auth?.token;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

/**
 * Room membership for the content surfaces: one post, or one feed.
 *
 * Registered on both the default namespace and `/posts`, because a client may
 * connect to either and the engagement broadcaster emits through the default
 * namespace's server handle.
 *
 * Nothing here unsubscribes on disconnect, deliberately: Socket.IO's adapter
 * removes a closing socket from every room it holds, so a manual sweep would be
 * a second cleanup authority that can only ever disagree with the first.
 */
export function registerContentRoomHandlers(
  socket: AuthenticatedContentSocket,
  rateLimiter: SocketRateLimiter,
): void {
  // A join is asynchronous, so two rapid requests for the same post would both
  // pay for the ACL. The second is dropped rather than queued — it would be
  // asking a question already in flight.
  const pendingJoins = new Set<string>();

  socket.on('joinPost', rateLimiter.wrap(socket, 'joinPost', (postId: string) => {
    if (!postId || typeof postId !== 'string') return;
    if (pendingJoins.has(postId)) return;
    pendingJoins.add(postId);
    // Membership in `pendingJoins` doubles as "this join is still wanted":
    // `leavePost` removes the entry, and the `finally` below only clears it once
    // this attempt has finished.
    void joinPostRoom(socket, postId, () => pendingJoins.has(postId))
      .catch((error) => {
        logger.warn('Post room join failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        pendingJoins.delete(postId);
      });
  }));

  socket.on('leavePost', rateLimiter.wrap(socket, 'leavePost', (postId: string) => {
    if (!postId || typeof postId !== 'string') return;
    // Cancels an in-flight join too: without this, a client that opened and
    // immediately closed a post would land in a room it had already left.
    pendingJoins.delete(postId);
    socket.leave(postEngagementRoom(postId));
  }));

  socket.on('joinFeed', rateLimiter.wrap(socket, 'joinFeed', (data: { feedType?: string }) => {
    const feedType = data?.feedType;
    if (feedType && typeof feedType === 'string') {
      socket.join(`feed:${feedType}`);
    }
    const selfId = socket.user?.id;
    if (selfId) socket.join(`feed:user:${selfId}`);
  }));

  socket.on('leaveFeed', rateLimiter.wrap(socket, 'leaveFeed', (data: { feedType?: string }) => {
    const feedType = data?.feedType;
    if (feedType && typeof feedType === 'string') {
      socket.leave(`feed:${feedType}`);
    }
    const selfId = socket.user?.id;
    if (selfId) socket.leave(`feed:user:${selfId}`);
  }));
}
