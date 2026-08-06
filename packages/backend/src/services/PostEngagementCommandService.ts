/**
 * The engagement WRITE path: like, downvote, save, and their removals.
 *
 * ## One transaction, three writes
 *
 * A relationship row (`likes` / `bookmarks`), the denormalized counter on
 * `posts`, and the durable `engagement_outbox` event commit together or not at
 * all. That is the whole design: the counter can never disagree with the rows it
 * projects, and no side effect (MTN, federation, notifications) is scheduled for
 * a relationship that was rolled back. `enqueueEngagementOutboxEvent` takes a
 * `Transaction`, so "enqueue outside the transaction" does not typecheck.
 *
 * ## Isolation: READ COMMITTED, deliberately
 *
 * The Mongoose version opened every command with `readConcern: 'snapshot'`,
 * which reads as "serializable" and translates most directly to Postgres
 * REPEATABLE READ. It is NOT ported, and the reason is that REPEATABLE READ
 * would be strictly worse here: two viewers liking the same post concurrently
 * would abort one transaction with a serialization failure (SQLSTATE 40001) that
 * the retry below does not answer for, turning a normal race into a 500. Under
 * READ COMMITTED, `greatest(0, stats_likes_count + 1)` takes a row lock and
 * re-reads the latest version, which is exactly the atomic counter the snapshot
 * was there to guarantee. The relationship's own uniqueness is enforced by the
 * index, not by isolation level.
 *
 * ## Counters are clamped, not trusted
 *
 * `greatest(0, …)` is the port of Mongo's `$max: [0, …]`. A counter that a
 * legacy writer left ahead of reality must not be driven negative by a correct
 * decrement; `EngagementProjectionReconciliationService` is what re-derives it.
 *
 * ## There is no id-shape guard, and that is the fix
 *
 * The Mongoose version called `isValidObjectId` before touching anything, purely
 * to dodge a `CastError`. A Postgres `text` id needs no such guard: a uuid v7
 * matches its row, a pre-cutover ObjectId hex matches its row, and an id that is
 * neither matches nothing — which is the `EngagementPostNotFoundError` (→ 404)
 * every caller was already written for.
 */

import { and, eq, sql } from 'drizzle-orm';
import { getDb, type Transaction } from '../db/postgres';
import type { SelectedRow } from '@oxyhq/db';
import { bookmarks, likes } from '../db/schema/engagement';
import { posts } from '../db/schema/posts';
import {
  enqueueEngagementOutboxEvent,
  type EngagementVoteValue,
  type EnqueueEngagementEventInput,
} from './EngagementOutboxService';

export class EngagementPostNotFoundError extends Error {
  constructor(postId: string) {
    super(`Post not found: ${postId}`);
    this.name = 'EngagementPostNotFoundError';
  }
}

/**
 * A concurrent writer created the relationship between this command's read and
 * its insert.
 *
 * Internal to the retry below and never observed by a caller: the command is
 * re-run, sees the winner, and answers with the ordinary idempotent no-op.
 */
class EngagementRelationshipRaceError extends Error {
  constructor(postId: string) {
    super(`Engagement relationship was created concurrently for post ${postId}`);
    this.name = 'EngagementRelationshipRaceError';
  }
}

/**
 * The post state an engagement response is built from.
 *
 * FLAT, matching the columns. Mongo's `stats.*` / `federation.*` were subdocument
 * nesting, not structure anyone chose, and re-nesting Postgres columns into that
 * shape for one internal DTO would be carrying the baggage forward. The HTTP
 * response bodies in `posts.controller.ts` are unchanged.
 */
const POST_SNAPSHOT_COLUMNS = {
  oxyUserId: posts.oxyUserId,
  federationActivityId: posts.federationActivityId,
  statsLikesCount: posts.statsLikesCount,
  statsDownvotesCount: posts.statsDownvotesCount,
  statsSavesCount: posts.statsSavesCount,
} as const;

export type EngagementPostSnapshot = SelectedRow<typeof POST_SNAPSHOT_COLUMNS>;

export interface SaveCommandResult {
  changed: boolean;
  bookmarkId?: string;
  outboxEventId?: string;
  post: EngagementPostSnapshot;
}

export interface VoteCommandResult {
  changed: boolean;
  likeId?: string;
  outboxEventId?: string;
  previousValue: EngagementVoteValue | null;
  value: EngagementVoteValue | null;
  post: EngagementPostSnapshot;
}

export type MaterializedEngagementKind = 'like' | 'bookmark';

const MAX_RELATIONSHIP_RACE_RETRIES = 3;

/**
 * Two first-time requests can race on the relationship's unique index. Retry the
 * loser so it observes the winner and returns the normal idempotent no-op
 * instead of leaking a 500 to the client.
 *
 * The retry restarts the TRANSACTION, which is mandatory rather than tidy: a
 * failed statement aborts the whole Postgres transaction, so continuing inside
 * it is not an option.
 *
 * It answers for the SENTINEL alone, and deliberately not for a raw `23505`:
 * every relationship insert below is `ON CONFLICT DO NOTHING`, so a duplicate
 * key never surfaces as a driver error at all — it surfaces as an insert that
 * returned no row. A `isUniqueViolation` arm here would be a branch that cannot
 * fire, and one that would quietly start swallowing an unrelated index's
 * violation the day somebody removed the conflict clause.
 */
async function inIdempotentTransaction<T>(
  operation: (tx: Transaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_RELATIONSHIP_RACE_RETRIES; attempt += 1) {
    try {
      return await getDb().transaction(operation);
    } catch (error) {
      if (
        !(error instanceof EngagementRelationshipRaceError) ||
        attempt === MAX_RELATIONSHIP_RACE_RETRIES
      ) {
        throw error;
      }
    }
  }
  throw new Error('Unreachable engagement transaction retry state');
}

/**
 * Narrow a stored vote to the closed set. TOTAL — `likes_value_check` already
 * forbids anything but `1` and `-1`, and the Mongoose version treated every
 * non-`-1` value as an upvote for the same reason.
 */
function asVoteValue(value: number): EngagementVoteValue {
  return value === -1 ? -1 : 1;
}

async function loadPost(
  postId: string,
  tx: Transaction,
): Promise<EngagementPostSnapshot> {
  const [post] = await tx
    .select(POST_SNAPSHOT_COLUMNS)
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);
  if (!post) throw new EngagementPostNotFoundError(postId);
  return post;
}

/**
 * Apply the counter deltas and return the post as it now stands.
 *
 * One statement: the increment, the clamp and the read-back are the same UPDATE
 * … RETURNING, so there is no window in which the response could report a value
 * another transaction has already moved.
 */
async function updateCounters(
  postId: string,
  tx: Transaction,
  delta: { likes?: number; downvotes?: number; saves?: number },
): Promise<EngagementPostSnapshot> {
  const [post] = await tx
    .update(posts)
    .set({
      ...(delta.likes
        ? {
            statsLikesCount: sql`greatest(0, ${posts.statsLikesCount} + ${delta.likes})`,
          }
        : {}),
      ...(delta.downvotes
        ? {
            statsDownvotesCount: sql`greatest(0, ${posts.statsDownvotesCount} + ${delta.downvotes})`,
          }
        : {}),
      ...(delta.saves
        ? {
            statsSavesCount: sql`greatest(0, ${posts.statsSavesCount} + ${delta.saves})`,
          }
        : {}),
    })
    .where(eq(posts.id, postId))
    .returning(POST_SNAPSHOT_COLUMNS);
  if (!post) throw new EngagementPostNotFoundError(postId);
  return post;
}

async function enqueuePostEngagementEvent(
  event: Omit<EnqueueEngagementEventInput, 'payload'> & {
    actorOxyUserId: string;
    postId: string;
    post: EngagementPostSnapshot;
    previousValue?: EngagementVoteValue | null;
    value?: EngagementVoteValue | null;
  },
  tx: Transaction,
): Promise<string> {
  return enqueueEngagementOutboxEvent(
    {
      kind: event.kind,
      relationshipId: event.relationshipId,
      revision: event.revision,
      payload: {
        actorOxyUserId: event.actorOxyUserId,
        postId: event.postId,
        relationshipId: event.relationshipId,
        postOwnerOxyUserId: event.post.oxyUserId ?? undefined,
        federationActivityId: event.post.federationActivityId ?? undefined,
        previousValue: event.previousValue,
        value: event.value,
      },
    },
    tx,
  );
}

/**
 * `bookmarks` is the single relationship authority. `ON CONFLICT DO NOTHING`
 * decides `changed` without a round trip and without an abort: a row came back
 * ⇒ this call created it, no row ⇒ it already existed and nothing else in this
 * transaction should run.
 */
export async function savePostCommand(input: {
  userId: string;
  postId: string;
}): Promise<SaveCommandResult> {
  return inIdempotentTransaction(async (tx) => {
    const currentPost = await loadPost(input.postId, tx);
    const [bookmark] = await tx
      .insert(bookmarks)
      .values({
        userId: input.userId,
        postId: input.postId,
        // NULL is "unfiled". It must never be `''`, which is a folder literally
        // named "" and collides for real in the sparse-unique folder index.
        folder: null,
      })
      .onConflictDoNothing({ target: [bookmarks.userId, bookmarks.postId] })
      .returning({ id: bookmarks.id });

    if (!bookmark) {
      return { changed: false, post: currentPost };
    }
    const post = await updateCounters(input.postId, tx, { saves: 1 });
    const outboxEventId = await enqueuePostEngagementEvent(
      {
        kind: 'post.save',
        relationshipId: bookmark.id,
        revision: 1,
        actorOxyUserId: input.userId,
        postId: input.postId,
        post,
      },
      tx,
    );
    return { changed: true, bookmarkId: bookmark.id, outboxEventId, post };
  });
}

export async function unsavePostCommand(input: {
  userId: string;
  postId: string;
}): Promise<SaveCommandResult> {
  return inIdempotentTransaction(async (tx) => {
    const currentPost = await loadPost(input.postId, tx);
    const [bookmark] = await tx
      .delete(bookmarks)
      .where(
        and(eq(bookmarks.userId, input.userId), eq(bookmarks.postId, input.postId)),
      )
      .returning({ id: bookmarks.id });
    if (!bookmark) {
      return { changed: false, post: currentPost };
    }
    const post = await updateCounters(input.postId, tx, { saves: -1 });
    const outboxEventId = await enqueuePostEngagementEvent(
      {
        kind: 'post.unsave',
        relationshipId: bookmark.id,
        revision: 2,
        actorOxyUserId: input.userId,
        postId: input.postId,
        post,
      },
      tx,
    );
    return { changed: true, bookmarkId: bookmark.id, outboxEventId, post };
  });
}

/**
 * Like/downvote relation and both counters are one command. A concurrent retry
 * observes the committed relation and becomes an idempotent no-op instead of
 * incrementing twice.
 */
export async function votePostCommand(input: {
  userId: string;
  postId: string;
  value: EngagementVoteValue;
  source?: string;
}): Promise<VoteCommandResult> {
  return inIdempotentTransaction(async (tx) => {
    const currentPost = await loadPost(input.postId, tx);
    const [existing] = await tx
      .select({ id: likes.id, value: likes.value, revision: likes.revision })
      .from(likes)
      .where(and(eq(likes.userId, input.userId), eq(likes.postId, input.postId)))
      .limit(1);

    if (existing && asVoteValue(existing.value) === input.value) {
      return {
        changed: false,
        likeId: existing.id,
        previousValue: input.value,
        value: input.value,
        post: currentPost,
      };
    }

    if (existing) {
      const previousValue = asVoteValue(existing.value);
      // Legacy rows start at zero and receive revision 1 on their next
      // transition, which is why the CHECK is `>= 0` rather than `>= 1`.
      const revision = Math.max(0, existing.revision) + 1;
      await tx
        .update(likes)
        .set({
          value: input.value,
          revision,
          ...(input.source ? { source: input.source } : {}),
        })
        .where(eq(likes.id, existing.id));
      const post = await updateCounters(input.postId, tx, {
        likes: input.value === 1 ? 1 : -1,
        downvotes: input.value === -1 ? 1 : -1,
      });
      const outboxEventId = await enqueuePostEngagementEvent(
        {
          kind: input.value === 1 ? 'post.like' : 'post.downvote',
          relationshipId: existing.id,
          revision,
          actorOxyUserId: input.userId,
          postId: input.postId,
          post,
          previousValue,
          value: input.value,
        },
        tx,
      );
      return {
        changed: true,
        likeId: existing.id,
        outboxEventId,
        previousValue,
        value: input.value,
        post,
      };
    }

    const [created] = await tx
      .insert(likes)
      .values({
        userId: input.userId,
        postId: input.postId,
        value: input.value,
        revision: 1,
        ...(input.source ? { source: input.source } : {}),
      })
      .onConflictDoNothing({ target: [likes.userId, likes.postId] })
      .returning({ id: likes.id });
    if (!created) {
      // Somebody else's first vote committed between the SELECT above and this
      // INSERT. Restart so the retry reads their row rather than guessing at it.
      throw new EngagementRelationshipRaceError(input.postId);
    }

    const post = await updateCounters(input.postId, tx, {
      likes: input.value === 1 ? 1 : undefined,
      downvotes: input.value === -1 ? 1 : undefined,
    });
    const outboxEventId = await enqueuePostEngagementEvent(
      {
        kind: input.value === 1 ? 'post.like' : 'post.downvote',
        relationshipId: created.id,
        revision: 1,
        actorOxyUserId: input.userId,
        postId: input.postId,
        post,
        previousValue: null,
        value: input.value,
      },
      tx,
    );
    return {
      changed: true,
      likeId: created.id,
      outboxEventId,
      previousValue: null,
      value: input.value,
      post,
    };
  });
}

export async function removeVoteCommand(input: {
  userId: string;
  postId: string;
}): Promise<VoteCommandResult> {
  return inIdempotentTransaction(async (tx) => {
    const currentPost = await loadPost(input.postId, tx);
    const [existing] = await tx
      .delete(likes)
      .where(and(eq(likes.userId, input.userId), eq(likes.postId, input.postId)))
      .returning({ id: likes.id, value: likes.value, revision: likes.revision });
    if (!existing) {
      return {
        changed: false,
        previousValue: null,
        value: null,
        post: currentPost,
      };
    }

    const previousValue = asVoteValue(existing.value);
    const post = await updateCounters(input.postId, tx, {
      likes: previousValue === 1 ? -1 : undefined,
      downvotes: previousValue === -1 ? -1 : undefined,
    });
    const revision = Math.max(0, existing.revision) + 1;
    const outboxEventId = await enqueuePostEngagementEvent(
      {
        kind: previousValue === 1 ? 'post.unlike' : 'post.undownvote',
        relationshipId: existing.id,
        revision,
        actorOxyUserId: input.userId,
        postId: input.postId,
        post,
        previousValue,
        value: null,
      },
      tx,
    );
    return {
      changed: true,
      likeId: existing.id,
      outboxEventId,
      previousValue,
      value: null,
      post,
    };
  });
}

/**
 * Project one already-verified MTN relationship without re-emitting it to the
 * engagement outbox. The relationship and its denormalized counter still share
 * the same transaction as native HTTP writes, so reconciliation cannot race a
 * late node/backfill materialization.
 *
 * `ON CONFLICT DO NOTHING` names NO target on purpose, so it answers for both
 * unique indexes at once: the supplied MTN rkey already existing, and a row for
 * this (user, post) existing under a DIFFERENT rkey. Mongo could only express
 * the first — the second raised a duplicate-key error that the retry loop
 * re-raised three times and threw — which contradicted this function's own
 * idempotency contract. Both are now the same `{ changed: false }`.
 */
export async function materializeEngagementRelationship(input: {
  kind: MaterializedEngagementKind;
  /** Preserve a signed MTN rkey when present; external protocols may omit it. */
  relationshipId?: string;
  userId: string;
  postId: string;
}): Promise<{ changed: boolean }> {
  return inIdempotentTransaction(async (tx) => {
    // The foreign key would reject a missing post with a raw driver error;
    // callers are written for the typed one.
    await loadPost(input.postId, tx);

    const inserted =
      input.kind === 'bookmark'
        ? await tx
            .insert(bookmarks)
            .values({
              ...(input.relationshipId ? { id: input.relationshipId } : {}),
              userId: input.userId,
              postId: input.postId,
              folder: null,
            })
            .onConflictDoNothing()
            .returning({ id: bookmarks.id })
        : await tx
            .insert(likes)
            .values({
              ...(input.relationshipId ? { id: input.relationshipId } : {}),
              userId: input.userId,
              postId: input.postId,
              value: 1,
              revision: 1,
            })
            .onConflictDoNothing()
            .returning({ id: likes.id });

    if (inserted.length !== 1) return { changed: false };
    await updateCounters(
      input.postId,
      tx,
      input.kind === 'bookmark' ? { saves: 1 } : { likes: 1 },
    );
    return { changed: true };
  });
}

/**
 * Remove a verified MTN relationship and its counter atomically. The actor is
 * part of the delete predicate: a valid record from account A cannot tombstone
 * account B's relationship merely by naming its rkey.
 *
 * There is no "the post was deleted underneath us" branch any more. Both
 * relationship tables reference `posts` with `ON DELETE CASCADE`, so a row whose
 * post is gone cannot exist — the delete simply matches nothing and the command
 * answers `{ changed: false }`.
 */
export async function materializeEngagementTombstone(input: {
  kind: MaterializedEngagementKind;
  relationshipId?: string;
  postId?: string;
  userId: string;
}): Promise<{ changed: boolean }> {
  if (!input.relationshipId && !input.postId) {
    throw new Error('Materialized engagement tombstone needs a relationship or post id');
  }

  return inIdempotentTransaction(async (tx) => {
    if (input.kind === 'bookmark') {
      const [bookmark] = await tx
        .delete(bookmarks)
        .where(
          and(
            input.relationshipId ? eq(bookmarks.id, input.relationshipId) : undefined,
            input.postId ? eq(bookmarks.postId, input.postId) : undefined,
            eq(bookmarks.userId, input.userId),
          ),
        )
        .returning({ postId: bookmarks.postId });
      if (!bookmark) return { changed: false };
      await updateCounters(bookmark.postId, tx, { saves: -1 });
      return { changed: true };
    }

    const [like] = await tx
      .delete(likes)
      .where(
        and(
          input.relationshipId ? eq(likes.id, input.relationshipId) : undefined,
          input.postId ? eq(likes.postId, input.postId) : undefined,
          eq(likes.userId, input.userId),
          // An MTN like record only ever tombstones an UP-vote; a downvote is
          // not an `app.mention.feed.like` and must not be removed by one. The
          // predicate is also why only `likes` moves below: a row this delete
          // matched cannot have been a downvote.
          eq(likes.value, 1),
        ),
      )
      .returning({ postId: likes.postId });
    if (!like) return { changed: false };
    await updateCounters(like.postId, tx, { likes: -1 });
    return { changed: true };
  });
}
