import mongoose, { type ClientSession } from 'mongoose';
import Bookmark from '../models/Bookmark';
import Like from '../models/Like';
import Post from '../models/Post';
import {
  enqueueEngagementOutboxEvent,
  type EnqueueEngagementEventInput,
} from './EngagementOutboxService';

export class EngagementPostNotFoundError extends Error {
  constructor(postId: string) {
    super(`Post not found: ${postId}`);
    this.name = 'EngagementPostNotFoundError';
  }
}

export interface EngagementPostSnapshot {
  oxyUserId?: unknown;
  authorship?: unknown[];
  federation?: { activityId?: string };
  stats?: {
    likesCount?: number;
    downvotesCount?: number;
    savesCount?: number;
  };
}

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
  previousValue: 1 | -1 | null;
  value: 1 | -1 | null;
  post: EngagementPostSnapshot;
}

export type MaterializedEngagementKind = 'like' | 'bookmark';

const TRANSACTION_OPTIONS = {
  readPreference: 'primary' as const,
  readConcern: { level: 'snapshot' as const },
  writeConcern: { w: 'majority' as const },
};
const MAX_DUPLICATE_KEY_RETRIES = 3;

async function inTransaction<T>(
  operation: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const session = await mongoose.startSession();
  let result: T | undefined;
  try {
    await session.withTransaction(async () => {
      result = await operation(session);
    }, TRANSACTION_OPTIONS);
    if (result === undefined) {
      throw new Error('Engagement transaction completed without a result');
    }
    return result;
  } finally {
    await session.endSession();
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    Number((error as { code?: unknown }).code) === 11000
  );
}

/**
 * Two first-time requests can race on the relationship's unique index. Mongo
 * correctly aborts one transaction with E11000 after the winner commits; retry
 * that command so it observes the winner and returns the normal idempotent
 * no-op instead of leaking a 500 to the client.
 */
async function inIdempotentTransaction<T>(
  operation: (session: ClientSession) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_DUPLICATE_KEY_RETRIES; attempt += 1) {
    try {
      return await inTransaction(operation);
    } catch (error) {
      if (!isDuplicateKeyError(error) || attempt === MAX_DUPLICATE_KEY_RETRIES) {
        throw error;
      }
    }
  }
  throw new Error('Unreachable engagement transaction retry state');
}

function assertObjectId(postId: string): void {
  if (!mongoose.isValidObjectId(postId)) {
    throw new EngagementPostNotFoundError(postId);
  }
}

async function loadPost(
  postId: string,
  session: ClientSession,
): Promise<EngagementPostSnapshot> {
  const post = await Post.findById(postId)
    .select('oxyUserId authorship federation.activityId stats.likesCount stats.downvotesCount stats.savesCount')
    .session(session)
    .lean<EngagementPostSnapshot | null>();
  if (!post) throw new EngagementPostNotFoundError(postId);
  return post;
}

async function updateCounters(
  postId: string,
  session: ClientSession,
  delta: { likes?: number; downvotes?: number; saves?: number },
): Promise<EngagementPostSnapshot> {
  const addAndClamp = (field: string, increment: number) => ({
    $max: [0, { $add: [{ $ifNull: [field, 0] }, increment] }],
  });
  const set: Record<string, unknown> = {};
  if (delta.likes) {
    set['stats.likesCount'] = addAndClamp('$stats.likesCount', delta.likes);
  }
  if (delta.downvotes) {
    set['stats.downvotesCount'] = addAndClamp('$stats.downvotesCount', delta.downvotes);
  }
  if (delta.saves) {
    set['stats.savesCount'] = addAndClamp('$stats.savesCount', delta.saves);
  }

  const post = await Post.findByIdAndUpdate(
    postId,
    [{ $set: set }],
    { new: true, session },
  )
    .select('oxyUserId authorship federation.activityId stats.likesCount stats.downvotesCount stats.savesCount')
    .lean<EngagementPostSnapshot | null>();
  if (!post) throw new EngagementPostNotFoundError(postId);
  return post;
}

function optionalString(value: unknown): string | undefined {
  const normalized = value?.toString?.();
  return typeof normalized === 'string' && normalized.length > 0
    ? normalized
    : undefined;
}

async function enqueuePostEngagementEvent(
  event: Omit<EnqueueEngagementEventInput, 'payload'> & {
    actorOxyUserId: string;
    postId: string;
    post: EngagementPostSnapshot;
    previousValue?: 1 | -1 | null;
    value?: 1 | -1 | null;
  },
  session: ClientSession,
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
        postOwnerOxyUserId: optionalString(event.post.oxyUserId),
        postAuthorship: event.post.authorship,
        federationActivityId: event.post.federation?.activityId,
        previousValue: event.previousValue,
        value: event.value,
      },
    },
    session,
  );
}

/**
 * Bookmark is the single relationship authority. The unique compound index and
 * counter update commit in one transaction, so concurrent duplicate saves
 * cannot inflate the denormalized counter.
 */
export async function savePostCommand(input: {
  userId: string;
  postId: string;
}): Promise<SaveCommandResult> {
  assertObjectId(input.postId);
  return inIdempotentTransaction(async (session) => {
    const currentPost = await loadPost(input.postId, session);
    const bookmarkId = new mongoose.Types.ObjectId();
    const now = new Date();
    const write = await Bookmark.updateOne(
      { userId: input.userId, postId: input.postId },
      {
        $setOnInsert: {
          _id: bookmarkId,
          userId: input.userId,
          postId: new mongoose.Types.ObjectId(input.postId),
          folder: null,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true, session },
    );

    if (write.upsertedCount !== 1) {
      return { changed: false, post: currentPost };
    }
    const post = await updateCounters(input.postId, session, { saves: 1 });
    const relationshipId = bookmarkId.toHexString();
    const outboxEventId = await enqueuePostEngagementEvent(
      {
        kind: 'post.save',
        relationshipId,
        revision: 1,
        actorOxyUserId: input.userId,
        postId: input.postId,
        post,
      },
      session,
    );
    return { changed: true, bookmarkId: relationshipId, outboxEventId, post };
  });
}

export async function unsavePostCommand(input: {
  userId: string;
  postId: string;
}): Promise<SaveCommandResult> {
  assertObjectId(input.postId);
  return inIdempotentTransaction(async (session) => {
    const currentPost = await loadPost(input.postId, session);
    const bookmark = await Bookmark.findOneAndDelete({
      userId: input.userId,
      postId: input.postId,
    }).session(session);
    if (!bookmark) {
      return { changed: false, post: currentPost };
    }
    const post = await updateCounters(input.postId, session, { saves: -1 });
    const relationshipId = String(bookmark._id);
    const outboxEventId = await enqueuePostEngagementEvent(
      {
        kind: 'post.unsave',
        relationshipId,
        revision: 2,
        actorOxyUserId: input.userId,
        postId: input.postId,
        post,
      },
      session,
    );
    return { changed: true, bookmarkId: relationshipId, outboxEventId, post };
  });
}

/**
 * Like/downvote relation and both counters are one serializable command. A
 * concurrent retry observes the committed relation and becomes an idempotent
 * no-op instead of incrementing twice.
 */
export async function votePostCommand(input: {
  userId: string;
  postId: string;
  value: 1 | -1;
  source?: string;
}): Promise<VoteCommandResult> {
  assertObjectId(input.postId);
  return inIdempotentTransaction(async (session) => {
    const currentPost = await loadPost(input.postId, session);
    const existing = await Like.findOne({
      userId: input.userId,
      postId: input.postId,
    }).session(session);

    if (existing && (existing.value ?? 1) === input.value) {
      return {
        changed: false,
        likeId: String(existing._id),
        previousValue: input.value,
        value: input.value,
        post: currentPost,
      };
    }

    if (existing) {
      const previousValue = (existing.value ?? 1) as 1 | -1;
      const revision = Math.max(0, Number(existing.revision) || 0) + 1;
      existing.value = input.value;
      existing.revision = revision;
      if (input.source) existing.source = input.source;
      await existing.save({ session });
      const post = await updateCounters(input.postId, session, {
        likes: input.value === 1 ? 1 : -1,
        downvotes: input.value === -1 ? 1 : -1,
      });
      const relationshipId = String(existing._id);
      const outboxEventId = await enqueuePostEngagementEvent(
        {
          kind: input.value === 1 ? 'post.like' : 'post.downvote',
          relationshipId,
          revision,
          actorOxyUserId: input.userId,
          postId: input.postId,
          post,
          previousValue,
          value: input.value,
        },
        session,
      );
      return {
        changed: true,
        likeId: relationshipId,
        outboxEventId,
        previousValue,
        value: input.value,
        post,
      };
    }

    const [created] = await Like.create(
      [{
        userId: input.userId,
        postId: new mongoose.Types.ObjectId(input.postId),
        value: input.value,
        revision: 1,
        ...(input.source ? { source: input.source } : {}),
      }],
      { session },
    );
    const post = await updateCounters(input.postId, session, {
      likes: input.value === 1 ? 1 : undefined,
      downvotes: input.value === -1 ? 1 : undefined,
    });
    const relationshipId = String(created._id);
    const outboxEventId = await enqueuePostEngagementEvent(
      {
        kind: input.value === 1 ? 'post.like' : 'post.downvote',
        relationshipId,
        revision: 1,
        actorOxyUserId: input.userId,
        postId: input.postId,
        post,
        previousValue: null,
        value: input.value,
      },
      session,
    );
    return {
      changed: true,
      likeId: relationshipId,
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
  assertObjectId(input.postId);
  return inIdempotentTransaction(async (session) => {
    const currentPost = await loadPost(input.postId, session);
    const existing = await Like.findOneAndDelete({
      userId: input.userId,
      postId: input.postId,
    }).session(session);
    if (!existing) {
      return {
        changed: false,
        previousValue: null,
        value: null,
        post: currentPost,
      };
    }

    const previousValue = (existing.value ?? 1) as 1 | -1;
    const post = await updateCounters(input.postId, session, {
      likes: previousValue === 1 ? -1 : undefined,
      downvotes: previousValue === -1 ? -1 : undefined,
    });
    const relationshipId = String(existing._id);
    const revision = Math.max(0, Number(existing.revision) || 0) + 1;
    const outboxEventId = await enqueuePostEngagementEvent(
      {
        kind: previousValue === 1 ? 'post.unlike' : 'post.undownvote',
        relationshipId,
        revision,
        actorOxyUserId: input.userId,
        postId: input.postId,
        post,
        previousValue,
        value: null,
      },
      session,
    );
    return {
      changed: true,
      likeId: relationshipId,
      outboxEventId,
      previousValue,
      value: null,
      post,
    };
  });
}

/**
 * Project one already-verified MTN relationship without re-emitting it to the
 * engagement outbox. The relationship and its denormalized Post counter still
 * share the same snapshot transaction as native HTTP writes, so reconciliation
 * cannot race a late node/backfill materialization.
 */
export async function materializeEngagementRelationship(input: {
  kind: MaterializedEngagementKind;
  /** Preserve a signed MTN rkey when present; external protocols may omit it. */
  relationshipId?: string;
  userId: string;
  postId: string;
}): Promise<{ changed: boolean }> {
  assertObjectId(input.postId);
  if (input.relationshipId) assertObjectId(input.relationshipId);
  const relationshipObjectId = input.relationshipId
    ? new mongoose.Types.ObjectId(input.relationshipId)
    : new mongoose.Types.ObjectId();
  const postObjectId = new mongoose.Types.ObjectId(input.postId);
  const relationshipFilter = input.relationshipId
    ? { _id: relationshipObjectId }
    : { userId: input.userId, postId: postObjectId };

  return inIdempotentTransaction(async (session) => {
    await loadPost(input.postId, session);

    const write = input.kind === 'bookmark'
      ? await Bookmark.updateOne(
          relationshipFilter,
          {
            $setOnInsert: {
              _id: relationshipObjectId,
              userId: input.userId,
              postId: postObjectId,
              folder: null,
            },
          },
          { upsert: true, session },
        )
      : await Like.updateOne(
          relationshipFilter,
          {
            $setOnInsert: {
              _id: relationshipObjectId,
              userId: input.userId,
              postId: postObjectId,
              value: 1,
              revision: 1,
            },
          },
          { upsert: true, session },
        );

    if (write.upsertedCount !== 1) return { changed: false };
    await updateCounters(
      input.postId,
      session,
      input.kind === 'bookmark' ? { saves: 1 } : { likes: 1 },
    );
    return { changed: true };
  });
}

/**
 * Remove a verified MTN relationship and its counter atomically. The actor is
 * part of the delete predicate: a valid record from account A cannot tombstone
 * account B's relationship merely by naming its rkey.
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
  if (input.relationshipId) assertObjectId(input.relationshipId);
  if (input.postId) assertObjectId(input.postId);
  const relationshipFilter = {
    ...(input.relationshipId ? { _id: input.relationshipId } : {}),
    ...(input.postId ? { postId: input.postId } : {}),
    userId: input.userId,
  };

  return inIdempotentTransaction(async (session) => {
    const relationship = input.kind === 'bookmark'
      ? await Bookmark.findOneAndDelete(relationshipFilter).session(session)
      : await Like.findOneAndDelete({
          ...relationshipFilter,
          value: 1,
        }).session(session);

    if (!relationship) return { changed: false };
    const postId = String(relationship.postId);
    if (!mongoose.isValidObjectId(postId)) {
      throw new Error(`Materialized ${input.kind} has an invalid post id`);
    }

    if (input.kind === 'bookmark') {
      await updateCounters(postId, session, { saves: -1 }).catch(
        (error: unknown) => {
          if (error instanceof EngagementPostNotFoundError) return undefined;
          throw error;
        },
      );
    } else {
      const value = Number(
        'value' in relationship ? relationship.value ?? 1 : 1,
      );
      await updateCounters(
        postId,
        session,
        value === -1 ? { downvotes: -1 } : { likes: -1 },
      ).catch((error: unknown) => {
        if (error instanceof EngagementPostNotFoundError) return undefined;
        throw error;
      });
    }
    return { changed: true };
  });
}
