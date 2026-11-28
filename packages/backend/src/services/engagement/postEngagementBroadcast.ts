import {
  POST_ENGAGEMENT_EVENTS,
  postEngagementRoom,
  type PostEngagementCountsPayload,
  type PostEngagementEvent,
} from '@mention/shared-types';
import { getRuntimeSocketServer } from '../../runtime/socketServer';
import {
  loadEngagementCountPrivacy,
  visibleEngagementCounts,
  type EngagementCountPrivacy,
  type EngagementCounts,
} from './engagementCountPrivacy';
import { logger } from '../../utils/logger';

/**
 * The counters a single engagement write moved. Only the ones that actually
 * changed belong here; a counter the write did not touch is left for the
 * client's own copy.
 */
export type PostEngagementCounts = EngagementCounts;

export interface BroadcastPostEngagementInput {
  event: PostEngagementEvent;
  /** The post whose counters moved — for a boost, the ORIGINAL, not the boost row. */
  postId: string;
  /** Oxy id of that post's author; whose privacy settings decide what may be sent. */
  authorOxyUserId?: string;
  counts: PostEngagementCounts;
  /**
   * Whoever acted. Supply it for a PUBLIC action so the actor's own client can
   * discard the echo of the optimistic update it already applied. Omit it for a
   * private one (a save) — the room must not learn who saved a post.
   */
  actorId?: string;
}

function buildPayload(
  input: BroadcastPostEngagementInput,
  privacy: EngagementCountPrivacy,
): PostEngagementCountsPayload | undefined {
  const payload: PostEngagementCountsPayload = {
    postId: input.postId,
    timestamp: new Date().toISOString(),
  };
  if (input.actorId) payload.actorId = input.actorId;

  // Hidden counters are `null` here and are omitted from the wire.
  const visible = visibleEngagementCounts(input.counts, privacy);
  if (typeof visible.likes === 'number') payload.likesCount = visible.likes;
  if (typeof visible.downvotes === 'number') payload.downvotesCount = visible.downvotes;
  if (typeof visible.boosts === 'number') {
    payload.repostsCount = visible.boosts;
    payload.boostsCount = visible.boosts; // deprecated duplicate, see the payload type
  }
  if (typeof visible.replies === 'number') payload.repliesCount = visible.replies;
  if (typeof visible.saves === 'number') payload.savesCount = visible.saves;

  const carriesACount =
    payload.likesCount !== undefined ||
    payload.downvotesCount !== undefined ||
    payload.repostsCount !== undefined ||
    payload.repliesCount !== undefined ||
    payload.savesCount !== undefined;

  // Every counter this write moved is hidden, so the event has nothing a client
  // could apply. Sending it anyway would be a notification that the hidden
  // number changed, which is most of what hiding it was meant to prevent.
  return carriesACount ? payload : undefined;
}

/**
 * The event name clients shipped before the rename still listen for, emitted
 * beside the current one. Removed together with the other deprecated aliases.
 */
const LEGACY_EVENT_ALIAS: Partial<Record<string, string>> = {
  [POST_ENGAGEMENT_EVENTS.REPOSTED]: POST_ENGAGEMENT_EVENTS.BOOSTED,
  [POST_ENGAGEMENT_EVENTS.UNREPOSTED]: POST_ENGAGEMENT_EVENTS.UNBOOSTED,
};

/**
 * Push one post's new counters to everyone watching that post.
 *
 * Fire-and-forget by contract: callers `void` this after their own write has
 * committed, so a socket server that is absent (tests, one-shot scripts), a
 * settings read that fails, or a room nobody is in can never turn a successful
 * like into a failed request.
 */
export async function broadcastPostEngagement(input: BroadcastPostEngagementInput): Promise<void> {
  const io = getRuntimeSocketServer();
  if (!io || !input.postId) return;

  const payload = buildPayload(input, await loadEngagementCountPrivacy(input.authorOxyUserId));
  if (!payload) return;

  const room = io.to(postEngagementRoom(input.postId));
  room.emit(input.event, payload);
  // Clients shipped before the rename listen for the old event names.
  const legacy = LEGACY_EVENT_ALIAS[input.event];
  if (legacy) room.emit(legacy, payload);
}

/**
 * The same broadcast, detached and silenced — the shape every call site wants,
 * since none of them may fail a write because a socket did.
 */
export function emitPostEngagement(input: BroadcastPostEngagementInput): void {
  void broadcastPostEngagement(input).catch((error) => {
    logger.warn('[PostEngagementBroadcast] Failed to broadcast engagement counts', {
      event: input.event,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export { POST_ENGAGEMENT_EVENTS };
