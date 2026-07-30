import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../models/Post', () => ({
  default: {
    findById: vi.fn(),
    findByIdAndUpdate: vi.fn(),
  },
}));

vi.mock('../../models/Bookmark', () => ({
  default: {
    updateOne: vi.fn(),
    findOneAndDelete: vi.fn(),
  },
}));

vi.mock('../../models/Like', () => ({
  default: {
    updateOne: vi.fn(),
    findOne: vi.fn(),
    findOneAndDelete: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock('../../models/EngagementOutbox', () => ({
  ENGAGEMENT_OUTBOX_RETENTION_SECONDS: 30 * 24 * 60 * 60,
  default: {
    updateOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
}));

import Bookmark from '../../models/Bookmark';
import EngagementOutbox from '../../models/EngagementOutbox';
import Like from '../../models/Like';
import Post from '../../models/Post';
import {
  EngagementPostNotFoundError,
  materializeEngagementRelationship,
  materializeEngagementTombstone,
  removeVoteCommand,
  savePostCommand,
  unsavePostCommand,
  votePostCommand,
} from '../../services/PostEngagementCommandService';

function resolvedQuery<T>(value: T) {
  return {
    select: vi.fn().mockReturnThis(),
    session: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(value),
  };
}

function deletedQuery<T>(value: T) {
  return {
    session: vi.fn().mockResolvedValue(value),
  };
}

function mockPost(post: unknown, updated: unknown = post): void {
  vi.mocked(Post.findById).mockReturnValue(resolvedQuery(post) as never);
  vi.mocked(Post.findByIdAndUpdate).mockReturnValue(
    resolvedQuery(updated) as never,
  );
}

describe('PostEngagementCommandService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(mongoose, 'startSession').mockResolvedValue({
      withTransaction: vi.fn(async (operation: () => Promise<void>) => operation()),
      endSession: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('increments savesCount only for the unique bookmark winner', async () => {
    const postId = new mongoose.Types.ObjectId().toHexString();
    vi.mocked(Post.findById)
      .mockReturnValueOnce(resolvedQuery({ stats: { savesCount: 0 } }) as never)
      .mockReturnValueOnce(resolvedQuery({ stats: { savesCount: 1 } }) as never);
    vi.mocked(Bookmark.updateOne)
      .mockResolvedValueOnce({ upsertedCount: 1 } as never)
      .mockResolvedValueOnce({ upsertedCount: 0 } as never);
    vi.mocked(Post.findByIdAndUpdate).mockReturnValue(
      resolvedQuery({ stats: { savesCount: 1 } }) as never,
    );

    const first = await savePostCommand({ userId: 'viewer-a', postId });
    const duplicate = await savePostCommand({ userId: 'viewer-a', postId });

    expect(first.changed).toBe(true);
    expect(duplicate.changed).toBe(false);
    expect(first.post.stats?.savesCount).toBe(1);
    expect(duplicate.post.stats?.savesCount).toBe(1);
    expect(Post.findByIdAndUpdate).toHaveBeenCalledTimes(1);
    expect(EngagementOutbox.updateOne).toHaveBeenCalledTimes(1);
    expect(EngagementOutbox.updateOne).toHaveBeenCalledWith(
      { _id: first.outboxEventId },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          _id: first.outboxEventId,
          kind: 'post.save',
          revision: 1,
          payload: expect.objectContaining({
            actorOxyUserId: 'viewer-a',
            postId,
            relationshipId: first.bookmarkId,
          }),
          status: 'pending',
        }),
      }),
      expect.objectContaining({ upsert: true, session: expect.any(Object) }),
    );

    /**
     * The bookmark upsert must own both timestamps AND pass `timestamps: false`.
     * `Bookmark` declares `timestamps: true`, so without the option Mongoose adds
     * `updatedAt` to `$set`, one path lands under two operators, and the server
     * refuses the write — aborting this transaction, so every save fails. Without
     * the explicit fields, a duplicate save rewrites the existing bookmark and
     * bumps `updatedAt` on a relationship that did not change.
     */
    const [, bookmarkUpdate, bookmarkOptions] = vi.mocked(Bookmark.updateOne).mock
      .calls[0] as unknown as [
      unknown,
      { $setOnInsert?: Record<string, unknown> },
      { timestamps?: boolean } | undefined,
    ];
    expect(bookmarkUpdate.$setOnInsert).toHaveProperty('createdAt');
    expect(bookmarkUpdate.$setOnInsert).toHaveProperty('updatedAt');
    expect(bookmarkOptions?.timestamps).toBe(false);
  });

  it('rejects an invalid post id before creating an orphan bookmark', async () => {
    await expect(
      savePostCommand({ userId: 'viewer-a', postId: 'not-an-object-id' }),
    ).rejects.toBeInstanceOf(EngagementPostNotFoundError);
    expect(Bookmark.updateOne).not.toHaveBeenCalled();
    expect(EngagementOutbox.updateOne).not.toHaveBeenCalled();
  });

  it('retries a duplicate-key race and returns the idempotent save result', async () => {
    const postId = new mongoose.Types.ObjectId().toHexString();
    vi.mocked(Post.findById).mockReturnValue(
      resolvedQuery({ stats: { savesCount: 1 } }) as never,
    );
    vi.mocked(Bookmark.updateOne)
      .mockRejectedValueOnce(Object.assign(new Error('duplicate bookmark'), { code: 11000 }))
      .mockResolvedValueOnce({ upsertedCount: 0 } as never);

    const result = await savePostCommand({ userId: 'viewer-a', postId });

    expect(result.changed).toBe(false);
    expect(mongoose.startSession).toHaveBeenCalledTimes(2);
    expect(Post.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(EngagementOutbox.updateOne).not.toHaveBeenCalled();
  });

  it('increments the relationship revision and emits one deterministic switch event', async () => {
    const postId = new mongoose.Types.ObjectId().toHexString();
    const likeId = new mongoose.Types.ObjectId();
    const existing = {
      _id: likeId,
      value: -1 as const,
      revision: 2,
      save: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(Post.findById).mockReturnValue(
      resolvedQuery({
        oxyUserId: 'post-owner',
        authorship: [{ oxyUserId: 'post-owner', role: 'owner', status: 'accepted' }],
        federation: { activityId: 'https://remote.example/post/1' },
        stats: { likesCount: 0, downvotesCount: 1 },
      }) as never,
    );
    vi.mocked(Like.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(existing),
    } as never);
    vi.mocked(Post.findByIdAndUpdate).mockReturnValue(
      resolvedQuery({
        oxyUserId: 'post-owner',
        authorship: [{ oxyUserId: 'post-owner', role: 'owner', status: 'accepted' }],
        federation: { activityId: 'https://remote.example/post/1' },
        stats: { likesCount: 1, downvotesCount: 0 },
      }) as never,
    );

    const result = await votePostCommand({
      userId: 'viewer-a',
      postId,
      value: 1,
    });

    expect(existing.revision).toBe(3);
    expect(result.outboxEventId).toBe(`engagement:post.like:${likeId.toHexString()}:v3`);
    expect(existing.save).toHaveBeenCalledWith({ session: expect.any(Object) });
    expect(EngagementOutbox.updateOne).toHaveBeenCalledWith(
      { _id: result.outboxEventId },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          kind: 'post.like',
          revision: 3,
          payload: expect.objectContaining({
            actorOxyUserId: 'viewer-a',
            postOwnerOxyUserId: 'post-owner',
            previousValue: -1,
            value: 1,
          }),
        }),
      }),
      expect.objectContaining({ upsert: true, session: expect.any(Object) }),
    );
  });

  it('classifies a like-to-downvote switch as a downvote event', async () => {
    const postId = new mongoose.Types.ObjectId().toHexString();
    const likeId = new mongoose.Types.ObjectId();
    const existing = {
      _id: likeId,
      value: 1 as const,
      revision: 1,
      save: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(Post.findById).mockReturnValue(
      resolvedQuery({ stats: { likesCount: 1, downvotesCount: 0 } }) as never,
    );
    vi.mocked(Like.findOne).mockReturnValue({
      session: vi.fn().mockResolvedValue(existing),
    } as never);
    vi.mocked(Post.findByIdAndUpdate).mockReturnValue(
      resolvedQuery({ stats: { likesCount: 0, downvotesCount: 1 } }) as never,
    );

    const result = await votePostCommand({
      userId: 'viewer-a',
      postId,
      value: -1,
    });

    expect(result.outboxEventId).toBe(
      `engagement:post.downvote:${likeId.toHexString()}:v2`,
    );
    expect(EngagementOutbox.updateOne).toHaveBeenCalledWith(
      { _id: result.outboxEventId },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({ kind: 'post.downvote' }),
      }),
      expect.objectContaining({ upsert: true, session: expect.any(Object) }),
    );
  });

  it('materializes a bookmark and its counter in one transaction without an outbox loop', async () => {
    const postId = new mongoose.Types.ObjectId().toHexString();
    const relationshipId = new mongoose.Types.ObjectId().toHexString();
    vi.mocked(Post.findById).mockReturnValue(
      resolvedQuery({ stats: { savesCount: 0 } }) as never,
    );
    vi.mocked(Bookmark.updateOne).mockResolvedValue({
      upsertedCount: 1,
    } as never);
    vi.mocked(Post.findByIdAndUpdate).mockReturnValue(
      resolvedQuery({ stats: { savesCount: 1 } }) as never,
    );

    const result = await materializeEngagementRelationship({
      kind: 'bookmark',
      relationshipId,
      userId: 'viewer-a',
      postId,
    });

    expect(result).toEqual({ changed: true });
    expect(Bookmark.updateOne).toHaveBeenCalledWith(
      { _id: new mongoose.Types.ObjectId(relationshipId) },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          userId: 'viewer-a',
          postId: new mongoose.Types.ObjectId(postId),
        }),
      }),
      expect.objectContaining({ upsert: true, session: expect.any(Object) }),
    );
    expect(Post.findByIdAndUpdate).toHaveBeenCalledTimes(1);
    expect(EngagementOutbox.updateOne).not.toHaveBeenCalled();
  });

  it('materialized tombstones are actor-scoped and decrement only a deleted relation', async () => {
    const postId = new mongoose.Types.ObjectId().toHexString();
    const relationshipId = new mongoose.Types.ObjectId().toHexString();
    vi.mocked(Bookmark.findOneAndDelete).mockReturnValue({
      session: vi.fn().mockResolvedValue({
        _id: relationshipId,
        userId: 'viewer-a',
        postId: new mongoose.Types.ObjectId(postId),
      }),
    } as never);
    vi.mocked(Post.findByIdAndUpdate).mockReturnValue(
      resolvedQuery({ stats: { savesCount: 0 } }) as never,
    );

    const result = await materializeEngagementTombstone({
      kind: 'bookmark',
      relationshipId,
      userId: 'viewer-a',
    });

    expect(result).toEqual({ changed: true });
    expect(Bookmark.findOneAndDelete).toHaveBeenCalledWith({
      _id: relationshipId,
      userId: 'viewer-a',
    });
    expect(Post.findByIdAndUpdate).toHaveBeenCalledTimes(1);
    expect(EngagementOutbox.updateOne).not.toHaveBeenCalled();
  });

  it('rejects a missing post and always closes the transaction session', async () => {
    const postId = new mongoose.Types.ObjectId().toHexString();
    vi.mocked(Post.findById).mockReturnValue(resolvedQuery(null) as never);

    await expect(savePostCommand({ userId: 'viewer-a', postId }))
      .rejects.toBeInstanceOf(EngagementPostNotFoundError);

    const session = await vi.mocked(mongoose.startSession).mock.results[0]?.value;
    expect(session?.endSession).toHaveBeenCalledOnce();
  });

  it('fails if the transaction callback completes without executing the command', async () => {
    const endSession = vi.fn().mockResolvedValue(undefined);
    vi.mocked(mongoose.startSession).mockResolvedValueOnce({
      withTransaction: vi.fn().mockResolvedValue(undefined),
      endSession,
    } as never);
    const postId = new mongoose.Types.ObjectId().toHexString();

    await expect(savePostCommand({ userId: 'viewer-a', postId }))
      .rejects.toThrow('Engagement transaction completed without a result');
    expect(endSession).toHaveBeenCalledOnce();
  });

  it('does not retry ordinary errors and stops after the duplicate-key retry cap', async () => {
    const postId = new mongoose.Types.ObjectId().toHexString();
    mockPost({ stats: { savesCount: 0 } });
    vi.mocked(Bookmark.updateOne).mockRejectedValueOnce(new Error('ordinary'));

    await expect(savePostCommand({ userId: 'viewer-a', postId }))
      .rejects.toThrow('ordinary');
    expect(mongoose.startSession).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    vi.spyOn(mongoose, 'startSession').mockResolvedValue({
      withTransaction: vi.fn(async (operation: () => Promise<void>) => operation()),
      endSession: vi.fn().mockResolvedValue(undefined),
    } as never);
    mockPost({ stats: { savesCount: 0 } });
    vi.mocked(Bookmark.updateOne).mockRejectedValue(
      Object.assign(new Error('duplicate'), { code: '11000' }),
    );

    await expect(savePostCommand({ userId: 'viewer-a', postId }))
      .rejects.toThrow('duplicate');
    expect(mongoose.startSession).toHaveBeenCalledTimes(3);
  });

  it('unsaves idempotently and emits a deterministic event only when a row existed', async () => {
    const postId = new mongoose.Types.ObjectId().toHexString();
    const bookmarkId = new mongoose.Types.ObjectId();
    vi.mocked(Post.findById)
      .mockReturnValueOnce(resolvedQuery({ stats: { savesCount: 1 } }) as never)
      .mockReturnValueOnce(resolvedQuery({ stats: { savesCount: 0 } }) as never);
    vi.mocked(Bookmark.findOneAndDelete)
      .mockReturnValueOnce(deletedQuery(null) as never)
      .mockReturnValueOnce(deletedQuery({ _id: bookmarkId }) as never);
    vi.mocked(Post.findByIdAndUpdate).mockReturnValue(
      resolvedQuery({ stats: { savesCount: 0 } }) as never,
    );

    await expect(unsavePostCommand({ userId: 'viewer-a', postId }))
      .resolves.toMatchObject({ changed: false });
    const removed = await unsavePostCommand({ userId: 'viewer-a', postId });

    expect(removed).toMatchObject({
      changed: true,
      bookmarkId: bookmarkId.toHexString(),
      outboxEventId: `engagement:post.unsave:${bookmarkId.toHexString()}:v2`,
    });
  });

  it('returns an idempotent vote when the existing value already matches', async () => {
    const postId = new mongoose.Types.ObjectId().toHexString();
    const likeId = new mongoose.Types.ObjectId();
    mockPost({ stats: { likesCount: 1 } });
    vi.mocked(Like.findOne).mockReturnValue(
      deletedQuery({ _id: likeId, value: undefined }) as never,
    );

    await expect(votePostCommand({
      userId: 'viewer-a',
      postId,
      value: 1,
    })).resolves.toMatchObject({
      changed: false,
      likeId: likeId.toHexString(),
      previousValue: 1,
      value: 1,
    });
    expect(Like.create).not.toHaveBeenCalled();
  });

  it.each([
    { value: 1 as const, kind: 'post.like', source: 'api' },
    { value: -1 as const, kind: 'post.downvote', source: undefined },
  ])('creates a first $kind relationship with the correct counter', async ({
    value,
    kind,
    source,
  }) => {
    const postId = new mongoose.Types.ObjectId().toHexString();
    const likeId = new mongoose.Types.ObjectId();
    mockPost(
      { stats: { likesCount: 0, downvotesCount: 0 } },
      { stats: { likesCount: value === 1 ? 1 : 0, downvotesCount: value === -1 ? 1 : 0 } },
    );
    vi.mocked(Like.findOne).mockReturnValue(deletedQuery(null) as never);
    vi.mocked(Like.create).mockResolvedValue([{ _id: likeId }] as never);

    const result = await votePostCommand({
      userId: 'viewer-a',
      postId,
      value,
      source,
    });

    expect(result).toMatchObject({
      changed: true,
      previousValue: null,
      value,
      outboxEventId: `engagement:${kind}:${likeId.toHexString()}:v1`,
    });
  });

  it('removes missing, upvote and downvote rows idempotently', async () => {
    const postId = new mongoose.Types.ObjectId().toHexString();
    const likeId = new mongoose.Types.ObjectId();
    vi.mocked(Post.findById).mockReturnValue(
      resolvedQuery({ stats: { likesCount: 1, downvotesCount: 1 } }) as never,
    );
    vi.mocked(Post.findByIdAndUpdate).mockReturnValue(
      resolvedQuery({ stats: { likesCount: 0, downvotesCount: 0 } }) as never,
    );
    vi.mocked(Like.findOneAndDelete)
      .mockReturnValueOnce(deletedQuery(null) as never)
      .mockReturnValueOnce(deletedQuery({ _id: likeId, value: 1, revision: 2 }) as never)
      .mockReturnValueOnce(deletedQuery({ _id: likeId, value: -1, revision: undefined }) as never);

    await expect(removeVoteCommand({ userId: 'viewer-a', postId }))
      .resolves.toMatchObject({ changed: false, value: null });
    await expect(removeVoteCommand({ userId: 'viewer-a', postId }))
      .resolves.toMatchObject({
        changed: true,
        previousValue: 1,
        outboxEventId: `engagement:post.unlike:${likeId.toHexString()}:v3`,
      });
    await expect(removeVoteCommand({ userId: 'viewer-a', postId }))
      .resolves.toMatchObject({
        changed: true,
        previousValue: -1,
        outboxEventId: `engagement:post.undownvote:${likeId.toHexString()}:v1`,
      });
  });

  it('materializes likes with generated relationship ids and treats duplicates as no-ops', async () => {
    const postId = new mongoose.Types.ObjectId().toHexString();
    mockPost({ stats: { likesCount: 0 } }, { stats: { likesCount: 1 } });
    vi.mocked(Like.updateOne)
      .mockResolvedValueOnce({ upsertedCount: 1 } as never)
      .mockResolvedValueOnce({ upsertedCount: 0 } as never);

    await expect(materializeEngagementRelationship({
      kind: 'like',
      userId: 'viewer-a',
      postId,
    })).resolves.toEqual({ changed: true });
    await expect(materializeEngagementRelationship({
      kind: 'like',
      userId: 'viewer-a',
      postId,
    })).resolves.toEqual({ changed: false });
  });

  it('validates materialized tombstone selectors before opening a transaction', async () => {
    await expect(materializeEngagementTombstone({
      kind: 'bookmark',
      userId: 'viewer-a',
    })).rejects.toThrow('needs a relationship or post id');
    await expect(materializeEngagementTombstone({
      kind: 'bookmark',
      relationshipId: 'invalid',
      userId: 'viewer-a',
    })).rejects.toBeInstanceOf(EngagementPostNotFoundError);
  });

  it('handles absent and invalid tombstoned relationships without corrupting counters', async () => {
    const relationshipId = new mongoose.Types.ObjectId().toHexString();
    vi.mocked(Like.findOneAndDelete)
      .mockReturnValueOnce(deletedQuery(null) as never)
      .mockReturnValueOnce(deletedQuery({
        _id: relationshipId,
        postId: 'invalid',
        value: 1,
      }) as never);

    await expect(materializeEngagementTombstone({
      kind: 'like',
      relationshipId,
      userId: 'viewer-a',
    })).resolves.toEqual({ changed: false });
    await expect(materializeEngagementTombstone({
      kind: 'like',
      relationshipId,
      userId: 'viewer-a',
    })).rejects.toThrow('invalid post id');
  });

  it.each([
    { value: -1, counter: 'downvotesCount' },
    { value: undefined, counter: 'likesCount' },
  ])('decrements the authoritative $counter for a materialized like tombstone', async ({
    value,
  }) => {
    const postId = new mongoose.Types.ObjectId().toHexString();
    const relationshipId = new mongoose.Types.ObjectId().toHexString();
    vi.mocked(Like.findOneAndDelete).mockReturnValue(
      deletedQuery({
        _id: relationshipId,
        postId: new mongoose.Types.ObjectId(postId),
        ...(value === undefined ? {} : { value }),
      }) as never,
    );
    vi.mocked(Post.findByIdAndUpdate).mockReturnValue(
      resolvedQuery({ stats: { likesCount: 0, downvotesCount: 0 } }) as never,
    );

    await expect(materializeEngagementTombstone({
      kind: 'like',
      relationshipId,
      postId,
      userId: 'viewer-a',
    })).resolves.toEqual({ changed: true });
  });

  it('tolerates a post deleted after a materialized relationship was removed', async () => {
    const postId = new mongoose.Types.ObjectId().toHexString();
    const relationshipId = new mongoose.Types.ObjectId().toHexString();
    vi.mocked(Bookmark.findOneAndDelete).mockReturnValue(
      deletedQuery({
        _id: relationshipId,
        postId: new mongoose.Types.ObjectId(postId),
      }) as never,
    );
    vi.mocked(Post.findByIdAndUpdate).mockReturnValue(
      resolvedQuery(null) as never,
    );

    await expect(materializeEngagementTombstone({
      kind: 'bookmark',
      relationshipId,
      userId: 'viewer-a',
    })).resolves.toEqual({ changed: true });
  });
});
