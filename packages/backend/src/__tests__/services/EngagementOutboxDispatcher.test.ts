import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  emitLikeCreatedStrict: vi.fn(),
  emitTombstoneStrict: vi.fn(),
  emitBookmarkCreatedStrict: vi.fn(),
  federateAsResolvedActorAndWait: vi.fn(),
  createPostAuthorNotificationsStrict: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('../../services/mtn/MentionRecordEmitter', () => ({
  emitLikeCreatedStrict: mocks.emitLikeCreatedStrict,
  emitTombstoneStrict: mocks.emitTombstoneStrict,
  emitBookmarkCreatedStrict: mocks.emitBookmarkCreatedStrict,
  likeRecordUri: (userId: string, relationId: string) =>
    `mtn://${userId}/likes/${relationId}`,
  bookmarkRecordUri: (userId: string, relationId: string) =>
    `mtn://${userId}/bookmarks/${relationId}`,
}));

vi.mock('../../connectors/outboundFederation', () => ({
  federateAsResolvedActorAndWait: mocks.federateAsResolvedActorAndWait,
}));

vi.mock('../../utils/notificationUtils', () => ({
  createPostAuthorNotificationsStrict: mocks.createPostAuthorNotificationsStrict,
}));

vi.mock('../../services/EngagementOutboxService', () => ({
  dispatchEngagementOutbox: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: mocks.loggerInfo,
    warn: vi.fn(),
    error: mocks.loggerError,
  },
}));

import {
  EngagementOutboxDispatcher,
  handleEngagementOutboxEvent,
} from '../../services/EngagementOutboxDispatcher';
import {
  dispatchEngagementOutbox,
  type EngagementOutboxEvent,
} from '../../services/EngagementOutboxService';

function event(
  kind: EngagementOutboxEvent['kind'],
  overrides: Partial<EngagementOutboxEvent['payload']> = {},
): EngagementOutboxEvent {
  return {
    _id: `engagement:${kind}:relation-1:v1`,
    kind,
    revision: 1,
    payload: {
      actorOxyUserId: 'actor-1',
      postId: '507f1f77bcf86cd799439011',
      relationshipId: 'relation-1',
      postOwnerOxyUserId: 'owner-1',
      postAuthorship: [
        { oxyUserId: 'owner-1', role: 'owner', status: 'accepted' },
      ],
      federationActivityId: 'https://remote.example/post/1',
      ...overrides,
    },
    attempts: 1,
    availableAt: new Date(0),
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(0),
  };
}

describe('handleEngagementOutboxEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.emitLikeCreatedStrict.mockResolvedValue(undefined);
    mocks.emitTombstoneStrict.mockResolvedValue(undefined);
    mocks.emitBookmarkCreatedStrict.mockResolvedValue(undefined);
    mocks.federateAsResolvedActorAndWait.mockResolvedValue(undefined);
    mocks.createPostAuthorNotificationsStrict.mockResolvedValue(undefined);
    vi.mocked(dispatchEngagementOutbox).mockResolvedValue({
      processed: 0,
      failed: 0,
    });
  });

  it('delivers like MTN, notification and federation effects', async () => {
    mocks.federateAsResolvedActorAndWait.mockImplementationOnce(
      async (_actorId, _description, buildEvent) => {
        expect(buildEvent('alice')).toEqual({
          kind: 'post.like',
          like: {
            _id: 'relation-1',
            postId: '507f1f77bcf86cd799439011',
          },
          actorOxyUserId: 'actor-1',
          actorUsername: 'alice',
        });
      },
    );
    await handleEngagementOutboxEvent(event('post.like'));

    expect(mocks.emitLikeCreatedStrict).toHaveBeenCalledWith({
      likerOxyUserId: 'actor-1',
      likeRkey: 'relation-1',
      likedPostId: '507f1f77bcf86cd799439011',
      likedPostOwnerOxyUserId: 'owner-1',
      idempotencyKey: 'engagement:post.like:relation-1:v1',
      issuedAt: new Date(0),
    });
    expect(mocks.createPostAuthorNotificationsStrict).toHaveBeenCalledOnce();
    expect(mocks.federateAsResolvedActorAndWait).toHaveBeenCalledOnce();
  });

  it('surfaces a durable federation queue failure so the event remains retryable', async () => {
    mocks.federateAsResolvedActorAndWait.mockRejectedValueOnce(
      new Error('delivery queue unavailable'),
    );

    await expect(
      handleEngagementOutboxEvent(event('post.like')),
    ).rejects.toThrow('delivery queue unavailable');
  });

  it('retracts the prior like when an upvote becomes a downvote', async () => {
    await handleEngagementOutboxEvent(
      event('post.downvote', { previousValue: 1, value: -1 }),
    );

    expect(mocks.emitTombstoneStrict).toHaveBeenCalledOnce();
    expect(mocks.federateAsResolvedActorAndWait).toHaveBeenCalledOnce();
    expect(mocks.emitLikeCreatedStrict).not.toHaveBeenCalled();
  });

  it('does not publish a new downvote to MTN or federation', async () => {
    await handleEngagementOutboxEvent(
      event('post.downvote', {
        previousValue: null,
        value: -1,
        federationActivityId: undefined,
      }),
    );

    expect(mocks.emitTombstoneStrict).not.toHaveBeenCalled();
    expect(mocks.federateAsResolvedActorAndWait).not.toHaveBeenCalled();
  });

  it('does not federate a local-only like without a federation activity id', async () => {
    await handleEngagementOutboxEvent(event('post.like', {
      federationActivityId: undefined,
    }));

    expect(mocks.emitLikeCreatedStrict).toHaveBeenCalledOnce();
    expect(mocks.createPostAuthorNotificationsStrict).toHaveBeenCalledOnce();
    expect(mocks.federateAsResolvedActorAndWait).not.toHaveBeenCalled();
  });

  it('delivers unlike tombstones and treats undownvote as a local no-op', async () => {
    await handleEngagementOutboxEvent(event('post.unlike'));
    await handleEngagementOutboxEvent(event('post.undownvote'));

    expect(mocks.emitTombstoneStrict).toHaveBeenCalledOnce();
    expect(mocks.emitTombstoneStrict).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectUri: 'mtn://actor-1/likes/relation-1',
      }),
    );
    expect(mocks.federateAsResolvedActorAndWait).toHaveBeenCalledOnce();
  });

  it('persists save and unsave records under the relationship key', async () => {
    await handleEngagementOutboxEvent(event('post.save'));
    await handleEngagementOutboxEvent(event('post.unsave'));

    expect(mocks.emitBookmarkCreatedStrict).toHaveBeenCalledOnce();
    expect(mocks.emitBookmarkCreatedStrict).toHaveBeenCalledWith({
      ownerOxyUserId: 'actor-1',
      bookmarkRkey: 'relation-1',
      bookmarkedPostId: '507f1f77bcf86cd799439011',
      bookmarkedPostOwnerOxyUserId: 'owner-1',
      idempotencyKey: 'engagement:post.save:relation-1:v1',
      issuedAt: new Date(0),
    });
    expect(mocks.emitTombstoneStrict).toHaveBeenCalledWith({
      authorOxyUserId: 'actor-1',
      tombstoneRkey: 'relation-1',
      subjectUri: 'mtn://actor-1/bookmarks/relation-1',
      idempotencyKey: 'engagement:post.unsave:relation-1:v1',
      issuedAt: new Date(0),
    });
  });

  it('surfaces a downstream failure so the claim is retried', async () => {
    mocks.emitLikeCreatedStrict.mockRejectedValueOnce(new Error('MTN unavailable'));

    await expect(handleEngagementOutboxEvent(event('post.like'))).rejects.toThrow(
      'MTN unavailable',
    );
    expect(mocks.createPostAuthorNotificationsStrict).not.toHaveBeenCalled();
  });
});

describe('EngagementOutboxDispatcher lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(dispatchEngagementOutbox).mockResolvedValue({
      processed: 0,
      failed: 0,
    });
  });

  it('contains a claim failure instead of creating an unhandled timer rejection', async () => {
    vi.mocked(dispatchEngagementOutbox).mockRejectedValueOnce(
      new Error('Mongo unavailable'),
    );
    const dispatcher = new EngagementOutboxDispatcher();

    dispatcher.start();
    await dispatcher.stop();

    expect(mocks.loggerError).toHaveBeenCalledWith(
      '[EngagementOutbox] dispatch tick failed',
      { error: 'Mongo unavailable' },
    );
  });

  it('waits for active work and refuses queued ticks after stop', async () => {
    let resolveDispatch!: (result: { processed: number; failed: number }) => void;
    const pending = new Promise<{ processed: number; failed: number }>((resolve) => {
      resolveDispatch = resolve;
    });
    vi.mocked(dispatchEngagementOutbox).mockReturnValueOnce(pending);
    const dispatcher = new EngagementOutboxDispatcher();

    dispatcher.start();
    const signal = vi.mocked(dispatchEngagementOutbox).mock.calls[0]?.[0].signal;
    let stopped = false;
    const stopping = dispatcher.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(signal?.aborted).toBe(true);

    resolveDispatch({ processed: 0, failed: 0 });
    await stopping;
    await (dispatcher as unknown as { tick: () => Promise<void> }).tick();

    expect(dispatchEngagementOutbox).toHaveBeenCalledTimes(1);
  });

  it('is idempotent when started twice and reports non-empty batches', async () => {
    vi.mocked(dispatchEngagementOutbox).mockResolvedValueOnce({
      processed: 2,
      failed: 1,
    });
    const dispatcher = new EngagementOutboxDispatcher();

    dispatcher.start();
    dispatcher.start();
    await dispatcher.stop();

    expect(dispatchEngagementOutbox).toHaveBeenCalledTimes(1);
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      '[EngagementOutbox] dispatch batch complete',
      { processed: 2, failed: 1 },
    );
  });

  it('can stop before start and stringifies a non-Error dispatch failure', async () => {
    const idle = new EngagementOutboxDispatcher();
    await expect(idle.stop()).resolves.toBeUndefined();

    vi.mocked(dispatchEngagementOutbox).mockRejectedValueOnce('offline');
    const dispatcher = new EngagementOutboxDispatcher();
    dispatcher.start();
    await dispatcher.stop();

    expect(mocks.loggerError).toHaveBeenCalledWith(
      '[EngagementOutbox] dispatch tick failed',
      { error: 'offline' },
    );
  });

  it('supports timer handles without an unref method', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
      .mockReturnValue({} as ReturnType<typeof setInterval>);
    const dispatcher = new EngagementOutboxDispatcher();
    try {
      dispatcher.start();
      await dispatcher.stop();
    } finally {
      setIntervalSpy.mockRestore();
    }

    expect(dispatchEngagementOutbox).toHaveBeenCalledTimes(1);
  });

  it('does not let an older stop or completion clear a restarted dispatcher', async () => {
    let resolveFirst!: (value: { processed: number; failed: number }) => void;
    const firstDispatch = new Promise<{ processed: number; failed: number }>(
      (resolve) => {
        resolveFirst = resolve;
      },
    );
    vi.mocked(dispatchEngagementOutbox)
      .mockReturnValueOnce(firstDispatch)
      .mockResolvedValueOnce({ processed: 0, failed: 0 });
    const dispatcher = new EngagementOutboxDispatcher();

    dispatcher.start();
    const firstStop = dispatcher.stop();
    dispatcher.start();
    resolveFirst({ processed: 0, failed: 0 });
    await firstStop;
    await dispatcher.stop();

    // The restart reuses the still-active dispatch rather than overlapping it.
    expect(dispatchEngagementOutbox).toHaveBeenCalledTimes(1);
  });
});
