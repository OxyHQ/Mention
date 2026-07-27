import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

const mocks = vi.hoisted(() => ({
  startSession: vi.fn(),
  postFind: vi.fn(),
  postAggregate: vi.fn(),
  postBulkWrite: vi.fn(),
  bookmarkAggregate: vi.fn(),
  recentFind: vi.fn(),
  recentBulkWrite: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock('mongoose', async () => {
  const actual = await vi.importActual<typeof import('mongoose')>('mongoose');
  return {
    ...actual,
    default: {
      ...actual.default,
      startSession: mocks.startSession,
    },
  };
});

vi.mock('../../models/Post', () => ({
  default: {
    find: mocks.postFind,
    aggregate: mocks.postAggregate,
    bulkWrite: mocks.postBulkWrite,
  },
}));

vi.mock('../../models/Bookmark', () => ({
  default: {
    aggregate: mocks.bookmarkAggregate,
  },
}));

vi.mock('../../models/PostRecentReplier', () => ({
  POST_RECENT_REPLIER_LIMIT: 3,
  PostRecentReplier: {
    find: mocks.recentFind,
    bulkWrite: mocks.recentBulkWrite,
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { reconcileEngagementProjections } from '../../services/EngagementProjectionReconciliationService';

function iterable<T>(rows: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* rows;
    },
  };
}

function findCursor<T>(rows: T[]) {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.lean = () => chain;
  chain.cursor = () => iterable(rows);
  return chain;
}

describe('reconcileEngagementProjections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const session = {
      withTransaction: vi.fn(async (work: () => Promise<void>) => work()),
      endSession: vi.fn(async () => undefined),
    };
    mocks.startSession.mockResolvedValue(session);
    mocks.postBulkWrite.mockResolvedValue({ modifiedCount: 1 });
    mocks.recentBulkWrite.mockResolvedValue({ modifiedCount: 1 });

    const stalePostId = new Types.ObjectId('65fdc8c8c8c8c8c8c8c8c8c1');
    const bookmarkedPostId = new Types.ObjectId('65fdc8c8c8c8c8c8c8c8c8c2');
    mocks.postFind.mockReturnValue(findCursor([{ _id: stalePostId }]));
    mocks.recentFind.mockReturnValue(findCursor([{ postId: 'parent-stale' }]));

    mocks.bookmarkAggregate.mockImplementation((pipeline: unknown[]) => {
      const first = pipeline[0] as Record<string, unknown> | undefined;
      if (first && '$group' in first) {
        return {
          cursor: () => iterable([{ _id: bookmarkedPostId }]),
        };
      }
      const match = (first?.$match ?? {}) as {
        postId?: { $in?: Types.ObjectId[] };
      };
      const [postId] = match.postId?.$in ?? [];
      return {
        session: async () =>
          postId ? [{ _id: postId, count: 2 }] : [],
      };
    });

    mocks.postAggregate.mockImplementation((pipeline: unknown[]) => {
      const match = ((pipeline[0] as Record<string, unknown> | undefined)?.$match ??
        {}) as { parentPostId?: { $in?: string[]; $type?: string } };
      if (!match.parentPostId?.$in) {
        return {
          cursor: () => iterable([{ _id: 'parent-missing' }]),
        };
      }
      const [postId] = match.parentPostId.$in;
      return {
        session: async () => [
          {
            _id: postId,
            repliers: [
              {
                oxyUserId: `author-${postId}`,
                repliedAt: new Date('2026-01-01T00:00:00.000Z'),
              },
            ],
          },
        ],
      };
    });
  });

  it('reconciles stale and missing save/replier projections in snapshot transactions', async () => {
    const result = await reconcileEngagementProjections();

    expect(result).toEqual({
      saveBatches: 2,
      recentReplierBatches: 2,
    });
    expect(mocks.startSession).toHaveBeenCalledTimes(4);
    expect(mocks.postBulkWrite).toHaveBeenCalledTimes(2);
    expect(mocks.recentBulkWrite).toHaveBeenCalledTimes(2);
    expect(mocks.postBulkWrite).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          updateOne: expect.objectContaining({
            update: { $set: { 'stats.savesCount': 2 } },
          }),
        }),
      ]),
      expect.objectContaining({ ordered: false }),
    );
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      '[EngagementProjectionReconciliation] complete',
      result,
    );
  });

  it('skips invalid and empty candidate streams without opening transactions', async () => {
    mocks.postFind.mockReturnValue(findCursor([
      { _id: 'invalid-object-id' },
    ]));
    mocks.bookmarkAggregate.mockReturnValue({
      cursor: () => iterable([]),
    });
    mocks.recentFind.mockReturnValue(findCursor([
      { postId: '   ' },
      { _id: null },
    ]));
    mocks.postAggregate.mockReturnValue({
      cursor: () => iterable([]),
    });

    await expect(reconcileEngagementProjections()).resolves.toEqual({
      saveBatches: 0,
      recentReplierBatches: 0,
    });
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it('writes zero save counts and deletes empty recent-replier projections', async () => {
    const postId = new Types.ObjectId('65fdc8c8c8c8c8c8c8c8c8c3');
    mocks.postFind.mockReturnValue(findCursor([{ _id: postId }]));
    mocks.bookmarkAggregate.mockImplementation((pipeline: unknown[]) => {
      const first = pipeline[0] as Record<string, unknown> | undefined;
      if (first && '$group' in first) {
        return { cursor: () => iterable([]) };
      }
      return { session: async () => [] };
    });
    mocks.recentFind.mockReturnValue(findCursor([{ postId: 'parent-empty' }]));
    mocks.postAggregate.mockImplementation((pipeline: unknown[]) => {
      const match = ((pipeline[0] as Record<string, unknown> | undefined)?.$match ??
        {}) as { parentPostId?: { $in?: string[] } };
      if (!match.parentPostId?.$in) {
        return { cursor: () => iterable([]) };
      }
      return { session: async () => [] };
    });

    await reconcileEngagementProjections();

    expect(mocks.postBulkWrite).toHaveBeenCalledWith(
      [expect.objectContaining({
        updateOne: expect.objectContaining({
          update: { $set: { 'stats.savesCount': 0 } },
        }),
      })],
      expect.objectContaining({ ordered: false }),
    );
    expect(mocks.recentBulkWrite).toHaveBeenCalledWith(
      [{ deleteOne: { filter: { postId: 'parent-empty' } } }],
      expect.objectContaining({ ordered: false }),
    );
  });

  it('flushes exact full batches without an extra trailing transaction', async () => {
    const objectIds = Array.from({ length: 100 }, () => ({
      _id: new Types.ObjectId(),
    }));
    const parentIds = Array.from({ length: 100 }, (_, index) => ({
      postId: `parent-${index}`,
    }));
    mocks.postFind.mockReturnValue(findCursor(objectIds));
    mocks.bookmarkAggregate.mockImplementation((pipeline: unknown[]) => {
      const first = pipeline[0] as Record<string, unknown> | undefined;
      if (first && '$group' in first) {
        return { cursor: () => iterable([]) };
      }
      return { session: async () => [] };
    });
    mocks.recentFind.mockReturnValue(findCursor(parentIds));
    mocks.postAggregate.mockImplementation((pipeline: unknown[]) => {
      const match = ((pipeline[0] as Record<string, unknown> | undefined)?.$match ??
        {}) as { parentPostId?: { $in?: string[] } };
      if (!match.parentPostId?.$in) {
        return { cursor: () => iterable([]) };
      }
      return { session: async () => [] };
    });

    await expect(reconcileEngagementProjections()).resolves.toEqual({
      saveBatches: 1,
      recentReplierBatches: 1,
    });
    expect(mocks.startSession).toHaveBeenCalledTimes(2);
  });

  it.each([
    'TransientTransactionError',
    'UnknownTransactionCommitResult',
  ])('retries a transaction carrying the %s label', async (retryLabel) => {
    const transient = {
      hasErrorLabel: vi.fn((label: string) => label === retryLabel),
    };
    const failedSession = {
      withTransaction: vi.fn().mockRejectedValue(transient),
      endSession: vi.fn().mockResolvedValue(undefined),
    };
    const successfulSession = {
      withTransaction: vi.fn(async (work: () => Promise<void>) => work()),
      endSession: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(mocks.startSession)
      .mockResolvedValueOnce(failedSession)
      .mockResolvedValueOnce(successfulSession);
    mocks.bookmarkAggregate.mockImplementation((pipeline: unknown[]) => {
      const first = pipeline[0] as Record<string, unknown> | undefined;
      if (first && '$group' in first) {
        return { cursor: () => iterable([]) };
      }
      return { session: async () => [] };
    });
    mocks.recentFind.mockReturnValue(findCursor([]));
    mocks.postAggregate.mockReturnValue({
      cursor: () => iterable([]),
    });

    await expect(reconcileEngagementProjections()).resolves.toMatchObject({
      saveBatches: 1,
    });
    expect(failedSession.endSession).toHaveBeenCalledOnce();
    expect(successfulSession.endSession).toHaveBeenCalledOnce();
  });

  it('does not retry a non-transactional error', async () => {
    const failedSession = {
      withTransaction: vi.fn().mockRejectedValue('not retryable'),
      endSession: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(mocks.startSession).mockResolvedValueOnce(failedSession);

    await expect(reconcileEngagementProjections()).rejects.toBe('not retryable');
    expect(mocks.startSession).toHaveBeenCalledTimes(1);
    expect(failedSession.endSession).toHaveBeenCalledOnce();
  });

  it('stops retrying a numeric transient error after the bounded attempt cap', async () => {
    const sessions = Array.from({ length: 3 }, () => ({
      withTransaction: vi.fn().mockRejectedValue({ code: 112 }),
      endSession: vi.fn().mockResolvedValue(undefined),
    }));
    for (const session of sessions) {
      vi.mocked(mocks.startSession).mockResolvedValueOnce(session);
    }

    await expect(reconcileEngagementProjections()).rejects.toEqual({ code: 112 });
    expect(mocks.startSession).toHaveBeenCalledTimes(3);
    for (const session of sessions) {
      expect(session.endSession).toHaveBeenCalledOnce();
    }
  });
});
