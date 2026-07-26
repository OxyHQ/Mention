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
  savePostCommand,
  votePostCommand,
} from '../../services/PostEngagementCommandService';

function resolvedQuery<T>(value: T) {
  return {
    select: vi.fn().mockReturnThis(),
    session: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(value),
  };
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
});
