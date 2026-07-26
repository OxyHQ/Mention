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
});
