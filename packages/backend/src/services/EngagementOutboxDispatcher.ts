import { asc, eq, sql } from 'drizzle-orm';
import type { PostAuthorshipEntry } from '@mention/shared-types';
import { federateAsResolvedActorAndWait } from '../connectors/outboundFederation';
import { getDb } from '../db/postgres';
import { postAuthorships } from '../db/schema/postContent';
import {
  bookmarkRecordUri,
  emitBookmarkCreatedStrict,
  emitLikeCreatedStrict,
  emitTombstoneStrict,
  likeRecordUri,
} from './mtn/MentionRecordEmitter';
import {
  dispatchEngagementOutbox,
  type EngagementOutboxEvent,
} from './EngagementOutboxService';
import { createPostAuthorNotificationsStrict } from '../utils/notificationUtils';
import { logger } from '../utils/logger';

const DISPATCH_INTERVAL_MS = 1_000;
const DISPATCH_BATCH_SIZE = 100;

/**
 * The post's authorship, read at DELIVERY time.
 *
 * `engagement_outbox` used to carry a `postAuthorship` snapshot taken when the
 * event was emitted — a `Mixed` array Mongo could not otherwise join to. The
 * column is dropped: it is reconstructible from `post_authorships`, which is the
 * authority the rest of the codebase already reads.
 *
 * The behaviour change is real and intended. A collaborator who accepted between
 * the like and its delivery now receives the notification, and one who was
 * removed does not — where the snapshot would have answered with the membership
 * as it stood seconds earlier. Neither answer is more correct in the abstract;
 * this one cannot go stale, and it cannot disagree with the byline the reader
 * sees on the post.
 *
 * Ordered owner-first, then by user id. The array Mongo carried was owner-first
 * (`buildAuthorship`), and a child table has no inherent order, so this restores
 * the familiar shape and makes the result deterministic. It is NOT load-bearing:
 * `getNotificationRecipients` finds the owner by predicate, never by position.
 */
async function loadPostAuthorship(postId: string): Promise<PostAuthorshipEntry[]> {
  const rows = await getDb()
    .select({
      oxyUserId: postAuthorships.oxyUserId,
      role: postAuthorships.role,
      status: postAuthorships.status,
      invitedAt: postAuthorships.invitedAt,
      respondedAt: postAuthorships.respondedAt,
    })
    .from(postAuthorships)
    .where(eq(postAuthorships.postId, postId))
    .orderBy(
      sql`case when ${postAuthorships.role} = 'owner' then 0 else 1 end`,
      asc(postAuthorships.oxyUserId),
    );

  return rows.map((row) => ({
    oxyUserId: row.oxyUserId,
    role: row.role,
    status: row.status,
    // `PostAuthorshipEntry` carries these as ISO strings and OMITS them when
    // absent; drizzle hands back `null`, which is not the same thing.
    ...(row.invitedAt ? { invitedAt: row.invitedAt.toISOString() } : {}),
    ...(row.respondedAt ? { respondedAt: row.respondedAt.toISOString() } : {}),
  }));
}

async function deliverFederatedLike(
  event: EngagementOutboxEvent,
  kind: 'post.like' | 'post.unlike',
): Promise<void> {
  if (!event.payload.federationActivityId) return;
  const { actorOxyUserId, postId, relationshipId } = event.payload;
  await federateAsResolvedActorAndWait(
    actorOxyUserId,
    `${kind} outbox ${event.id}`,
    (username) => ({
      kind,
      like: { _id: relationshipId, postId },
      actorOxyUserId,
      actorUsername: username,
    }),
  );
}

/**
 * Execute every durable engagement side effect. Each downstream identity is
 * deterministic: MTN preserves the relationship rkey and deduplicates by the
 * durable event id, ActivityPub uses that relation id, and Notification has a
 * unique actor/type/entity index.
 */
export async function handleEngagementOutboxEvent(
  event: EngagementOutboxEvent,
): Promise<void> {
  const {
    actorOxyUserId,
    postId,
    relationshipId,
    postOwnerOxyUserId,
    previousValue,
  } = event.payload;
  const mtnEventIdentity = {
    idempotencyKey: event.id,
    issuedAt: event.createdAt,
  };

  switch (event.kind) {
    case 'post.like':
      await emitLikeCreatedStrict({
        likerOxyUserId: actorOxyUserId,
        likeRkey: relationshipId,
        likedPostId: postId,
        likedPostOwnerOxyUserId: postOwnerOxyUserId,
        ...mtnEventIdentity,
      });
      await createPostAuthorNotificationsStrict(await loadPostAuthorship(postId), {
        actorId: actorOxyUserId,
        type: 'like',
        entityId: postId,
        entityType: 'post',
      });
      await deliverFederatedLike(event, 'post.like');
      return;

    case 'post.unlike':
      await emitTombstoneStrict({
        authorOxyUserId: actorOxyUserId,
        tombstoneRkey: relationshipId,
        subjectUri: likeRecordUri(actorOxyUserId, relationshipId),
        ...mtnEventIdentity,
      });
      await deliverFederatedLike(event, 'post.unlike');
      return;

    case 'post.downvote':
      // A new downvote has no cross-network side effect. Switching from an
      // upvote must durably retract the prior MTN/AP Like.
      if (previousValue === 1) {
        await emitTombstoneStrict({
          authorOxyUserId: actorOxyUserId,
          tombstoneRkey: relationshipId,
          subjectUri: likeRecordUri(actorOxyUserId, relationshipId),
          ...mtnEventIdentity,
        });
        await deliverFederatedLike(event, 'post.unlike');
      }
      return;

    case 'post.undownvote':
      return;

    case 'post.save':
      await emitBookmarkCreatedStrict({
        ownerOxyUserId: actorOxyUserId,
        bookmarkRkey: relationshipId,
        bookmarkedPostId: postId,
        bookmarkedPostOwnerOxyUserId: postOwnerOxyUserId,
        ...mtnEventIdentity,
      });
      return;

    case 'post.unsave':
      await emitTombstoneStrict({
        authorOxyUserId: actorOxyUserId,
        tombstoneRkey: relationshipId,
        subjectUri: bookmarkRecordUri(actorOxyUserId, relationshipId),
        ...mtnEventIdentity,
      });
      return;
  }
}

export class EngagementOutboxDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  private running = false;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, DISPATCH_INTERVAL_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    const controller = this.abortController;
    controller?.abort();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.inFlight;
    if (this.abortController === controller) {
      this.abortController = null;
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    if (this.inFlight) return this.inFlight;
    const work = dispatchEngagementOutbox({
      handler: handleEngagementOutboxEvent,
      batchSize: DISPATCH_BATCH_SIZE,
      signal: this.abortController?.signal,
    })
      .then(({ processed, failed }) => {
        if (processed > 0 || failed > 0) {
          logger.info('[EngagementOutbox] dispatch batch complete', {
            processed,
            failed,
          });
        }
      })
      .catch((error) => {
        // Claim/database failures happen outside the per-event retry block.
        // Keep the interval alive and avoid an unhandled rejection.
        logger.error('[EngagementOutbox] dispatch tick failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (this.inFlight === work) this.inFlight = null;
      });
    this.inFlight = work;
    return work;
  }
}

export const engagementOutboxDispatcher = new EngagementOutboxDispatcher();
