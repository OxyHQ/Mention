import {
  POST_ENGAGEMENT_EVENTS,
  postEngagementRoom,
  type PostEngagementCountsPayload,
  type PostEngagementEvent,
} from '@mention/shared-types';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { userSettings } from '../db/schema/userProfile';
import { getRuntimeSocketServer } from '../runtime/socketServer';
import {
  DEFAULT_PRIVACY,
  readEngagementCountPrivacy,
  type EngagementCountPrivacy,
} from './engagementCountPrivacy';
import { logger } from '../utils/logger';

/**
 * The counters a single engagement write moved, named the way the models name
 * them. Only the ones that actually changed belong here; a counter the write did
 * not touch is left for the client's own copy.
 */
export interface PostEngagementCounts {
  likes?: number;
  downvotes?: number;
  boosts?: number;
  replies?: number;
  saves?: number;
}

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

async function loadAuthorCountPrivacy(
  authorOxyUserId: string | undefined,
): Promise<EngagementCountPrivacy> {
  if (!authorOxyUserId) return { ...DEFAULT_PRIVACY };
  try {
    // The four columns are flat and `NOT NULL`, so the row IS a
    // `CountPrivacySource` — but it still goes through the shared reader,
    // because this broadcast must hide exactly what the DTO hides.
    const [settings] = await getDb()
      .select({
        hideLikeCounts: userSettings.privacyHideLikeCounts,
        hideShareCounts: userSettings.privacyHideShareCounts,
        hideReplyCounts: userSettings.privacyHideReplyCounts,
        hideSaveCounts: userSettings.privacyHideSaveCounts,
      })
      .from(userSettings)
      .where(eq(userSettings.oxyUserId, authorOxyUserId))
      .limit(1);
    return readEngagementCountPrivacy(settings);
  } catch (error) {
    // Same fallback the render path takes, for the same reason: a settings-load
    // failure must not make the live number and the reloaded number disagree.
    logger.warn('[PostEngagementBroadcast] Failed to load author count privacy', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ...DEFAULT_PRIVACY };
  }
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

  // Likes and downvotes are two faces of one vote and share one author control,
  // so a vote that switched sides reports both or neither.
  if (!privacy.hideLikeCounts) {
    if (typeof input.counts.likes === 'number') payload.likesCount = input.counts.likes;
    if (typeof input.counts.downvotes === 'number') payload.downvotesCount = input.counts.downvotes;
  }
  if (!privacy.hideShareCounts && typeof input.counts.boosts === 'number') {
    payload.boostsCount = input.counts.boosts;
  }
  if (!privacy.hideReplyCounts && typeof input.counts.replies === 'number') {
    payload.repliesCount = input.counts.replies;
  }
  if (!privacy.hideSaveCounts && typeof input.counts.saves === 'number') {
    payload.savesCount = input.counts.saves;
  }

  const carriesACount =
    payload.likesCount !== undefined ||
    payload.downvotesCount !== undefined ||
    payload.boostsCount !== undefined ||
    payload.repliesCount !== undefined ||
    payload.savesCount !== undefined;

  // Every counter this write moved is hidden, so the event has nothing a client
  // could apply. Sending it anyway would be a notification that the hidden
  // number changed, which is most of what hiding it was meant to prevent.
  return carriesACount ? payload : undefined;
}

/**
 * Push one post's new counters to everyone watching that post.
 *
 * Fire-and-forget by contract: callers `void` this after their own write has
 * committed, so a socket server that is absent (tests, one-shot scripts), a
 * settings read that fails, or a room nobody is in can never turn a successful
 * like into a failed request.
 */
export async function broadcastPostEngagement(
  input: BroadcastPostEngagementInput,
): Promise<void> {
  const io = getRuntimeSocketServer();
  if (!io || !input.postId) return;

  const payload = buildPayload(input, await loadAuthorCountPrivacy(input.authorOxyUserId));
  if (!payload) return;

  io.to(postEngagementRoom(input.postId)).emit(input.event, payload);
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
