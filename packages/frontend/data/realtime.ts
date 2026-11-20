import { type EventSocket, realtime } from '@oxy.so/bloom-data';
import type { PostEngagementCountsPayload, PostEngagementEvent } from '@mention/shared-types';
import { POST_ENGAGEMENT_EVENTS } from '@mention/shared-types/realtime';
import type { EchoAction } from '@/services/echoGuard';
import { Post } from './posts';

/**
 * The counters a post-engagement event carried. A counter the author hides
 * never arrives, so an absent one means "leave the rendered value alone".
 */
type EngagementCounts = Partial<
  Record<'likes' | 'downvotes' | 'boosts' | 'replies' | 'saves', number>
>;

/**
 * Each engagement event and the local action it echoes. The action is only
 * used to ask "did this device just do that?"; the counters in the payload are
 * what is applied.
 */
const ENGAGEMENT_EVENT_ACTIONS: ReadonlyArray<[PostEngagementEvent, EchoAction]> = [
  [POST_ENGAGEMENT_EVENTS.LIKED, 'like'],
  [POST_ENGAGEMENT_EVENTS.UNLIKED, 'unlike'],
  [POST_ENGAGEMENT_EVENTS.BOOSTED, 'boost'],
  [POST_ENGAGEMENT_EVENTS.UNBOOSTED, 'unboost'],
  [POST_ENGAGEMENT_EVENTS.SAVED, 'save'],
  [POST_ENGAGEMENT_EVENTS.UNSAVED, 'unsave'],
  [POST_ENGAGEMENT_EVENTS.REPLIED, 'reply'],
];

export const ENGAGEMENT_EVENTS: readonly PostEngagementEvent[] = ENGAGEMENT_EVENT_ACTIONS.map(
  ([event]) => event,
);

function readEngagementCounts(data: PostEngagementCountsPayload): EngagementCounts {
  const counts: EngagementCounts = {};
  if (typeof data.likesCount === 'number') counts.likes = data.likesCount;
  if (typeof data.downvotesCount === 'number') counts.downvotes = data.downvotesCount;
  if (typeof data.boostsCount === 'number') counts.boosts = data.boostsCount;
  if (typeof data.repliesCount === 'number') counts.replies = data.repliesCount;
  if (typeof data.savesCount === 'number') counts.saves = data.savesCount;
  return counts;
}

/**
 * Live engagement counters from the `post:<id>` rooms, written into the same
 * posts the feeds and the post screen read (`@oxy.so/bloom-data` `realtime`).
 * Events are applied after the next frame, in arrival order, with one
 * notification: the newest value of each counter stands, and only the views
 * that read a changed counter re-render.
 *
 * `viewerState` is never touched: a room event describes what somebody else
 * did, and the one time it describes this viewer it is an echo of a state
 * they already set (`ignore`). Every count on the wire is the server's total,
 * never a delta, so an echo cannot double-count; it is skipped only so the
 * number does not flicker.
 */
export function postEngagementRealtime(
  socket: EventSocket,
  ignore: (postId: string, action: EchoAction, actorId?: string) => boolean,
): () => void {
  return realtime(
    socket,
    Object.fromEntries(
      ENGAGEMENT_EVENT_ACTIONS.map(([event, action]) => [
        event,
        (data: PostEngagementCountsPayload) => {
          const postId = data?.postId;
          if (!postId || ignore(postId, action, data.actorId)) return;
          const counts = readEngagementCounts(data);
          if (Object.keys(counts).length === 0) return;
          Post.merge(postId, { engagement: counts });
        },
      ]),
    ),
  );
}
