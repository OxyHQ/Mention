import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const downstream = vi.hoisted(() => ({
  emitLikeCreatedStrict: vi.fn(),
  emitTombstoneStrict: vi.fn(),
  emitBookmarkCreatedStrict: vi.fn(),
  federateAsResolvedActorAndWait: vi.fn(),
  createPostAuthorNotificationsStrict: vi.fn(),
}));

vi.mock('../../models/EngagementOutbox', () => ({
  ENGAGEMENT_OUTBOX_RETENTION_SECONDS: 30 * 24 * 60 * 60,
  default: {
    updateOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    exists: vi.fn(),
  },
}));

vi.mock('../../services/mtn/MentionRecordEmitter', () => ({
  emitLikeCreatedStrict: downstream.emitLikeCreatedStrict,
  emitTombstoneStrict: downstream.emitTombstoneStrict,
  emitBookmarkCreatedStrict: downstream.emitBookmarkCreatedStrict,
  likeRecordUri: (userId: string, relationId: string) =>
    `mtn://${userId}/likes/${relationId}`,
  bookmarkRecordUri: (userId: string, relationId: string) =>
    `mtn://${userId}/bookmarks/${relationId}`,
}));

vi.mock('../../connectors/outboundFederation', () => ({
  federateAsResolvedActorAndWait: downstream.federateAsResolvedActorAndWait,
}));

vi.mock('../../utils/notificationUtils', () => ({
  createPostAuthorNotificationsStrict:
    downstream.createPostAuthorNotificationsStrict,
}));

import EngagementOutbox from '../../models/EngagementOutbox';
import { handleEngagementOutboxEvent } from '../../services/EngagementOutboxDispatcher';
import {
  claimEngagementOutboxEvent,
  completeEngagementOutboxEvent,
  dispatchEngagementOutbox,
  enqueueEngagementOutboxEvent,
  engagementOutboxEventId,
  failEngagementOutboxEvent,
} from '../../services/EngagementOutboxService';

function claimQuery(value: unknown) {
  return {
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(value),
  };
}

describe('EngagementOutboxService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(EngagementOutbox.exists).mockResolvedValue(null);
    downstream.emitLikeCreatedStrict.mockResolvedValue(undefined);
    downstream.emitTombstoneStrict.mockResolvedValue(undefined);
    downstream.emitBookmarkCreatedStrict.mockResolvedValue(undefined);
    downstream.federateAsResolvedActorAndWait.mockResolvedValue(undefined);
    downstream.createPostAuthorNotificationsStrict.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('derives stable ids from the relationship revision', () => {
    expect(engagementOutboxEventId('post.like', 'like-1', 3))
      .toBe('engagement:post.like:like-1:v3');
    expect(engagementOutboxEventId('post.like', 'like-1', 3))
      .toBe(engagementOutboxEventId('post.like', 'like-1', 3));
    expect(engagementOutboxEventId('post.like', 'like-1', 4))
      .not.toBe(engagementOutboxEventId('post.like', 'like-1', 3));
  });

  it('sets a hard expiry when enqueueing a durable event', async () => {
    vi.mocked(EngagementOutbox.updateOne).mockResolvedValue(
      { acknowledged: true } as never,
    );
    const before = Date.now();

    await enqueueEngagementOutboxEvent(
      {
        kind: 'post.save',
        relationshipId: 'bookmark-1',
        revision: 1,
        payload: {
          actorOxyUserId: 'viewer-a',
          postId: 'post-1',
          relationshipId: 'bookmark-1',
        },
      },
      {} as never,
    );

    const updateCalls = (
      vi.mocked(EngagementOutbox.updateOne).mock.calls
    ) as unknown as Array<[
        unknown,
        { $setOnInsert?: { expiresAt?: Date } },
      ]>;
    const update = updateCalls[0]?.[1];
    expect(updateCalls[0]?.[1].$setOnInsert).toEqual(
      expect.objectContaining({ revision: 1 }),
    );
    expect(update.$setOnInsert?.expiresAt).toBeInstanceOf(Date);
    expect(update.$setOnInsert?.expiresAt?.getTime()).toBeGreaterThanOrEqual(
      before + 30 * 24 * 60 * 60 * 1_000,
    );
  });

  it('atomically claims pending work or an expired lease', async () => {
    const now = new Date('2026-07-26T12:00:00.000Z');
    const event = {
      _id: 'engagement:post.save:bookmark-1:v1',
      kind: 'post.save' as const,
      revision: 1,
      payload: {
        actorOxyUserId: 'viewer-a',
        postId: 'post-1',
        relationshipId: 'bookmark-1',
      },
      attempts: 1,
      availableAt: now,
      leaseOwner: 'worker-a',
      leaseUntil: new Date(now.getTime() + 30_000),
      createdAt: now,
    };
    vi.mocked(EngagementOutbox.findOneAndUpdate).mockReturnValue(
      claimQuery(event) as never,
    );

    const claimed = await claimEngagementOutboxEvent({
      leaseOwner: 'worker-a',
      eventId: event._id,
      now,
      leaseMs: 30_000,
    });

    expect(claimed).toEqual(event);
    expect(EngagementOutbox.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: event._id,
        $or: [
          { status: 'pending', availableAt: { $lte: now } },
          { status: 'processing', leaseUntil: { $lte: now } },
        ],
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'processing',
          leaseOwner: 'worker-a',
          leaseUntil: new Date(now.getTime() + 30_000),
        }),
        $inc: { attempts: 1 },
      }),
      { new: true, sort: { createdAt: 1 } },
    );
  });

  it('only completes or releases the lease owner that claimed the event', async () => {
    const now = new Date('2026-07-26T12:00:00.000Z');
    vi.mocked(EngagementOutbox.updateOne)
      .mockResolvedValueOnce({ modifiedCount: 0 } as never)
      .mockResolvedValueOnce({ modifiedCount: 1 } as never);

    await expect(
      completeEngagementOutboxEvent('event-1', 'stale-worker', now),
    ).resolves.toBe(false);
    await expect(
      failEngagementOutboxEvent(
        { _id: 'event-1', attempts: 2 },
        'worker-a',
        new Error('downstream unavailable'),
        now,
      ),
    ).resolves.toBe(true);

    expect(EngagementOutbox.updateOne).toHaveBeenLastCalledWith(
      {
        _id: 'event-1',
        status: 'processing',
        leaseOwner: 'worker-a',
        leaseUntil: { $gt: now },
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'pending',
          availableAt: new Date(now.getTime() + 2_000),
          lastError: 'downstream unavailable',
        }),
        $unset: { leaseOwner: '', leaseUntil: '' },
      }),
    );
  });

  it('keeps a failed handler event pending for a later reclaim', async () => {
    const now = new Date();
    const event = {
      _id: 'engagement:post.unsave:bookmark-1:v2',
      kind: 'post.unsave' as const,
      revision: 2,
      payload: {
        actorOxyUserId: 'viewer-a',
        postId: 'post-1',
        relationshipId: 'bookmark-1',
      },
      attempts: 1,
      availableAt: now,
      leaseOwner: 'worker-a',
      leaseUntil: new Date(now.getTime() + 30_000),
      createdAt: now,
    };
    vi.mocked(EngagementOutbox.findOneAndUpdate)
      .mockReturnValueOnce(claimQuery(event) as never)
      .mockReturnValueOnce(claimQuery(null) as never);
    vi.mocked(EngagementOutbox.updateOne).mockResolvedValue(
      { modifiedCount: 1 } as never,
    );

    const result = await dispatchEngagementOutbox({
      leaseOwner: 'worker-a',
      batchSize: 2,
      handler: vi.fn().mockRejectedValue(new Error('temporary failure')),
    });

    expect(result).toEqual({ processed: 0, failed: 1 });
    expect(EngagementOutbox.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: event._id,
        status: 'processing',
        leaseOwner: 'worker-a',
        leaseUntil: { $gt: expect.any(Date) },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'pending',
          lastError: 'temporary failure',
        }),
      }),
    );
  });

  it('returns a like event to pending when durable federation cannot enqueue it', async () => {
    const now = new Date();
    const event = {
      _id: 'engagement:post.like:like-1:v1',
      kind: 'post.like' as const,
      revision: 1,
      payload: {
        actorOxyUserId: 'viewer-a',
        postId: 'post-1',
        relationshipId: 'like-1',
        postOwnerOxyUserId: 'owner-a',
        federationActivityId: 'https://remote.example/posts/1',
      },
      attempts: 1,
      availableAt: now,
      leaseOwner: 'worker-a',
      leaseUntil: new Date(now.getTime() + 30_000),
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
    };
    vi.mocked(EngagementOutbox.findOneAndUpdate)
      .mockReturnValueOnce(claimQuery(event) as never)
      .mockReturnValueOnce(claimQuery(null) as never);
    vi.mocked(EngagementOutbox.updateOne).mockResolvedValue(
      { modifiedCount: 1 } as never,
    );
    downstream.federateAsResolvedActorAndWait.mockRejectedValueOnce(
      new Error('delivery queue unavailable'),
    );

    const result = await dispatchEngagementOutbox({
      leaseOwner: 'worker-a',
      batchSize: 2,
      handler: handleEngagementOutboxEvent,
    });

    expect(result).toEqual({ processed: 0, failed: 1 });
    expect(EngagementOutbox.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: event._id,
        status: 'processing',
        leaseOwner: 'worker-a',
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'pending',
          lastError: 'delivery queue unavailable',
        }),
      }),
    );
  });

  it('defers a later relationship revision while an earlier one is unfinished', async () => {
    const now = new Date();
    const event = {
      _id: 'engagement:post.downvote:like-1:v2',
      kind: 'post.downvote' as const,
      revision: 2,
      payload: {
        actorOxyUserId: 'viewer-a',
        postId: 'post-1',
        relationshipId: 'like-1',
        previousValue: 1 as const,
        value: -1 as const,
      },
      attempts: 1,
      availableAt: now,
      leaseOwner: 'worker-b',
      leaseUntil: new Date(now.getTime() + 30_000),
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
    };
    vi.mocked(EngagementOutbox.findOneAndUpdate)
      .mockReturnValueOnce(claimQuery(event) as never)
      .mockReturnValueOnce(claimQuery(null) as never);
    vi.mocked(EngagementOutbox.exists).mockResolvedValue(
      { _id: 'engagement:post.like:like-1:v1' } as never,
    );
    vi.mocked(EngagementOutbox.updateOne).mockResolvedValue(
      { modifiedCount: 1 } as never,
    );
    const handler = vi.fn();

    const result = await dispatchEngagementOutbox({
      leaseOwner: 'worker-b',
      batchSize: 2,
      handler,
    });

    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(handler).not.toHaveBeenCalled();
    expect(EngagementOutbox.exists).toHaveBeenCalledWith({
      'payload.relationshipId': 'like-1',
      revision: { $lt: 2 },
      status: { $ne: 'processed' },
    });
    expect(EngagementOutbox.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: event._id,
        status: 'processing',
        leaseOwner: 'worker-b',
        leaseUntil: { $gt: expect.any(Date) },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'pending' }),
        $inc: { attempts: -1 },
        $unset: { leaseOwner: '', leaseUntil: '' },
      }),
    );
  });

  it('stops claiming new events after shutdown while completing current work', async () => {
    const now = new Date();
    const event = {
      _id: 'engagement:post.save:bookmark-1:v1',
      kind: 'post.save' as const,
      revision: 1,
      payload: {
        actorOxyUserId: 'viewer-a',
        postId: 'post-1',
        relationshipId: 'bookmark-1',
      },
      attempts: 1,
      availableAt: now,
      leaseOwner: 'worker-a',
      leaseUntil: new Date(now.getTime() + 30_000),
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
    };
    vi.mocked(EngagementOutbox.findOneAndUpdate).mockReturnValueOnce(
      claimQuery(event) as never,
    );
    vi.mocked(EngagementOutbox.updateOne).mockResolvedValue(
      { modifiedCount: 1 } as never,
    );
    const controller = new AbortController();
    const handler = vi.fn(async () => {
      controller.abort();
    });

    const result = await dispatchEngagementOutbox({
      leaseOwner: 'worker-a',
      batchSize: 100,
      signal: controller.signal,
      handler,
    });

    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(EngagementOutbox.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('renews a handler beyond its lease and keeps renewing during shutdown', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-07-26T12:00:00.000Z');
    vi.setSystemTime(now);
    const event = {
      _id: 'engagement:post.like:like-1:v1',
      kind: 'post.like' as const,
      revision: 1,
      payload: {
        actorOxyUserId: 'viewer-a',
        postId: 'post-1',
        relationshipId: 'like-1',
      },
      attempts: 1,
      availableAt: now,
      leaseOwner: 'worker-a',
      leaseUntil: new Date(now.getTime() + 1_000),
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
    };
    vi.mocked(EngagementOutbox.findOneAndUpdate).mockReturnValueOnce(
      claimQuery(event) as never,
    );
    vi.mocked(EngagementOutbox.updateOne).mockResolvedValue(
      { matchedCount: 1, modifiedCount: 1 } as never,
    );
    let finishHandler!: () => void;
    let markHandlerStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve;
    });
    const handlerBlock = new Promise<void>((resolve) => {
      finishHandler = resolve;
    });
    const controller = new AbortController();
    const handler = vi.fn(async () => {
      markHandlerStarted();
      await handlerBlock;
    });

    const dispatching = dispatchEngagementOutbox({
      leaseOwner: 'worker-a',
      leaseMs: 1_000,
      batchSize: 100,
      signal: controller.signal,
      handler,
    });
    await handlerStarted;
    controller.abort();
    await vi.advanceTimersByTimeAsync(2_500);

    const updateCalls = vi.mocked(
      EngagementOutbox.updateOne,
    ).mock.calls as unknown as Array<
      [Record<string, unknown>, { $set?: Record<string, unknown> }]
    >;
    const renewalCalls = updateCalls.filter(
      ([filter, update]) =>
        Boolean((filter as { leaseUntil?: unknown }).leaseUntil) &&
        !('status' in (update.$set ?? {})),
    );
    expect(renewalCalls.length).toBeGreaterThanOrEqual(2);

    finishHandler();
    await expect(dispatching).resolves.toEqual({ processed: 1, failed: 0 });
    expect(EngagementOutbox.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('waits for an in-flight renewal before completing an event', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-07-26T12:00:00.000Z');
    vi.setSystemTime(now);
    const event = {
      _id: 'engagement:post.save:bookmark-1:v1',
      kind: 'post.save' as const,
      revision: 1,
      payload: {
        actorOxyUserId: 'viewer-a',
        postId: 'post-1',
        relationshipId: 'bookmark-1',
      },
      attempts: 1,
      availableAt: now,
      leaseOwner: 'worker-a',
      leaseUntil: new Date(now.getTime() + 1_000),
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
    };
    vi.mocked(EngagementOutbox.findOneAndUpdate).mockReturnValueOnce(
      claimQuery(event) as never,
    );
    let resolveRenewal!: (value: { matchedCount: number }) => void;
    const renewal = new Promise<{ matchedCount: number }>((resolve) => {
      resolveRenewal = resolve;
    });
    vi.mocked(EngagementOutbox.updateOne).mockImplementation(
      ((filter: Record<string, unknown>, update: { $set?: Record<string, unknown> }) => {
        if (filter.leaseUntil && !update.$set?.status) {
          return renewal;
        }
        return Promise.resolve({ modifiedCount: 1 });
      }) as never,
    );
    let finishHandler!: () => void;
    const handlerBlock = new Promise<void>((resolve) => {
      finishHandler = resolve;
    });
    let markHandlerStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve;
    });
    const handler = vi.fn(async () => {
      markHandlerStarted();
      await handlerBlock;
    });

    const dispatching = dispatchEngagementOutbox({
      leaseOwner: 'worker-a',
      leaseMs: 1_000,
      batchSize: 1,
      handler,
    });
    await handlerStarted;
    await vi.advanceTimersByTimeAsync(334);
    finishHandler();
    await Promise.resolve();

    const updateCalls = vi.mocked(
      EngagementOutbox.updateOne,
    ).mock.calls as unknown as Array<
      [Record<string, unknown>, { $set?: { status?: unknown } }]
    >;
    const completionCallsBeforeRenewal = updateCalls.filter(
      ([, update]) =>
        update.$set?.status === 'processed',
    );
    expect(completionCallsBeforeRenewal).toHaveLength(0);

    resolveRenewal({ matchedCount: 1 });
    await expect(dispatching).resolves.toEqual({ processed: 1, failed: 0 });
  });

  it('detects renewal ownership loss and does not complete or release a stale lease', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-07-26T12:00:00.000Z');
    vi.setSystemTime(now);
    const event = {
      _id: 'engagement:post.like:like-1:v1',
      kind: 'post.like' as const,
      revision: 1,
      payload: {
        actorOxyUserId: 'viewer-a',
        postId: 'post-1',
        relationshipId: 'like-1',
      },
      attempts: 1,
      availableAt: now,
      leaseOwner: 'worker-a',
      leaseUntil: new Date(now.getTime() + 1_000),
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
    };
    vi.mocked(EngagementOutbox.findOneAndUpdate).mockReturnValueOnce(
      claimQuery(event) as never,
    );
    vi.mocked(EngagementOutbox.updateOne).mockResolvedValue(
      { matchedCount: 0, modifiedCount: 0 } as never,
    );
    let finishHandler!: () => void;
    let markHandlerStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve;
    });
    const handlerBlock = new Promise<void>((resolve) => {
      finishHandler = resolve;
    });
    const handler = vi.fn(async () => {
      markHandlerStarted();
      await handlerBlock;
    });

    const dispatching = dispatchEngagementOutbox({
      leaseOwner: 'worker-a',
      leaseMs: 1_000,
      batchSize: 1,
      handler,
    });
    await handlerStarted;
    await vi.advanceTimersByTimeAsync(334);
    finishHandler();

    await expect(dispatching).resolves.toEqual({ processed: 0, failed: 1 });
    expect(EngagementOutbox.updateOne).toHaveBeenCalledTimes(1);
    expect(EngagementOutbox.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: event._id,
        status: 'processing',
        leaseOwner: 'worker-a',
        leaseUntil: { $gt: expect.any(Date) },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ leaseUntil: expect.any(Date) }),
      }),
    );
  });
});
