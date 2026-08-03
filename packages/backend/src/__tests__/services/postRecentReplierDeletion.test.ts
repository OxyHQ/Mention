import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  aggregate: vi.fn(),
  find: vi.fn(),
  postDeleteMany: vi.fn(),
  projectionDeleteMany: vi.fn(),
  projectionDeleteOne: vi.fn(),
  projectionUpdateOne: vi.fn(),
  startSession: vi.fn(),
  warn: vi.fn(),
  aggregateRows: [] as Array<Array<{ oxyUserId: string; repliedAt: Date }>>,
  childRows: [] as Array<{ _id: unknown }>,
}));

vi.mock('mongoose', () => ({
  default: {
    startSession: (...args: unknown[]) => mocks.startSession(...args),
  },
}));

vi.mock('../../models/Post', () => ({
  default: {
    aggregate: (...args: unknown[]) => mocks.aggregate(...args),
    find: (...args: unknown[]) => mocks.find(...args),
    deleteMany: (...args: unknown[]) => mocks.postDeleteMany(...args),
  },
}));

vi.mock('../../models/PostRecentReplier', () => ({
  POST_RECENT_REPLIER_LIMIT: 3,
  PostRecentReplier: {
    deleteMany: (...args: unknown[]) => mocks.projectionDeleteMany(...args),
    deleteOne: (...args: unknown[]) => mocks.projectionDeleteOne(...args),
    updateOne: (...args: unknown[]) => mocks.projectionUpdateOne(...args),
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => mocks.warn(...args),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { repairRecentRepliersAfterPostDelete } from '../../services/PostRecentReplierService';

function createSession(options?: {
  afterTransaction?: () => void;
}) {
  const session = {
    withTransaction: vi.fn(async (operation: () => Promise<void>) => {
      await operation();
      options?.afterTransaction?.();
    }),
    endSession: vi.fn(async () => undefined),
  };
  return session;
}

describe('PostRecentReplierService deletion repair', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.aggregateRows.length = 0;
    mocks.childRows.length = 0;

    mocks.startSession.mockImplementation(async () => createSession());
    mocks.aggregate.mockImplementation(() => ({
      session: vi.fn(async () => mocks.aggregateRows.shift() ?? []),
    }));
    mocks.find.mockImplementation(() => {
      const query = {
        select: vi.fn(() => query),
        session: vi.fn(() => query),
        lean: vi.fn(async () => mocks.childRows),
      };
      return query;
    });
    mocks.postDeleteMany.mockResolvedValue({ deletedCount: 0 });
    mocks.projectionDeleteMany.mockResolvedValue({ deletedCount: 0 });
    mocks.projectionDeleteOne.mockResolvedValue({ deletedCount: 0 });
    mocks.projectionUpdateOne.mockResolvedValue({ matchedCount: 1 });
  });

  it('recomputes the parent from remaining public replies after deleting a reply', async () => {
    mocks.aggregateRows.push([
      { oxyUserId: 'newest', repliedAt: new Date('2026-07-26T12:00:00.000Z') },
      { oxyUserId: 'next', repliedAt: new Date('2026-07-26T11:00:00.000Z') },
    ]);

    await repairRecentRepliersAfterPostDelete({
      postId: 'deleted-reply',
      parentPostId: 'parent-post',
    });

    expect(mocks.projectionUpdateOne).toHaveBeenCalledWith(
      { postId: 'parent-post' },
      expect.objectContaining({
        $set: expect.objectContaining({
          repliers: [
            { oxyUserId: 'newest', repliedAt: new Date('2026-07-26T12:00:00.000Z') },
            { oxyUserId: 'next', repliedAt: new Date('2026-07-26T11:00:00.000Z') },
          ],
        }),
      }),
      expect.objectContaining({ upsert: true, session: expect.any(Object) }),
    );
    expect(mocks.projectionDeleteMany).toHaveBeenCalledWith(
      { postId: { $in: ['deleted-reply'] } },
      expect.objectContaining({ session: expect.any(Object) }),
    );
    expect(mocks.aggregate.mock.calls[0][0]).toEqual(
      expect.arrayContaining([
        {
          $match: expect.objectContaining({
            parentPostId: 'parent-post',
            visibility: 'public',
            status: 'published',
          }),
        },
        { $limit: 3 },
      ]),
    );
  });

  it('removes the parent projection when the deleted reply was the last eligible one', async () => {
    mocks.aggregateRows.push([]);

    await repairRecentRepliersAfterPostDelete({
      postId: 'last-reply',
      parentPostId: 'parent-post',
    });

    expect(mocks.projectionDeleteOne).toHaveBeenCalledWith(
      { postId: 'parent-post' },
      expect.objectContaining({ session: expect.any(Object) }),
    );
    expect(mocks.projectionUpdateOne).not.toHaveBeenCalled();
  });

  it('deletes the parent projection and projections for every child it deletes', async () => {
    mocks.childRows.push({ _id: 'child-one' }, { _id: 'child-two' });

    const deleted = await repairRecentRepliersAfterPostDelete({ postId: 'deleted-parent' });

    // The rows travel back to the caller so the deletion cascade can clean up
    // what the deleted replies referenced — nothing else knows they went.
    expect(deleted).toEqual([{ _id: 'child-one' }, { _id: 'child-two' }]);
    expect(mocks.aggregate).not.toHaveBeenCalled();
    expect(mocks.postDeleteMany).toHaveBeenCalledWith(
      { _id: { $in: ['child-one', 'child-two'] } },
      expect.objectContaining({ session: expect.any(Object) }),
    );
    expect(mocks.projectionDeleteMany).toHaveBeenCalledWith(
      {
        postId: {
          $in: ['deleted-parent', 'child-one', 'child-two'],
        },
      },
      expect.objectContaining({ session: expect.any(Object) }),
    );
  });

  it('retries a transient projection write conflict and recomputes from a fresh snapshot', async () => {
    mocks.aggregateRows.push(
      [{ oxyUserId: 'stale', repliedAt: new Date('2026-07-26T10:00:00.000Z') }],
      [{ oxyUserId: 'concurrent', repliedAt: new Date('2026-07-26T13:00:00.000Z') }],
    );

    let sessionAttempt = 0;
    mocks.startSession.mockImplementation(async () => {
      sessionAttempt += 1;
      if (sessionAttempt === 1) {
        return createSession({
          afterTransaction: () => {
            const error = new Error('WriteConflict') as Error & {
              code: number;
              hasErrorLabel: (label: string) => boolean;
            };
            error.code = 112;
            error.hasErrorLabel = (label) => label === 'TransientTransactionError';
            throw error;
          },
        });
      }
      return createSession();
    });

    await repairRecentRepliersAfterPostDelete({
      postId: 'deleted-reply',
      parentPostId: 'parent-post',
    });

    expect(mocks.startSession).toHaveBeenCalledTimes(2);
    expect(mocks.projectionUpdateOne).toHaveBeenCalledTimes(2);
    expect(mocks.projectionUpdateOne.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        $set: expect.objectContaining({
          repliers: [
            {
              oxyUserId: 'concurrent',
              repliedAt: new Date('2026-07-26T13:00:00.000Z'),
            },
          ],
        }),
      }),
    );
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('logs and reports no deleted replies when repair remains unavailable after the delete', async () => {
    mocks.startSession.mockRejectedValue(new Error('Mongo unavailable'));
    // A row this call did NOT delete must never be reported as deleted: the
    // caller sends the returned rows to the deletion cascade, so a false
    // positive here would strip the references off a reply that still exists.
    mocks.childRows.push({ _id: 'child-that-survived' });

    await expect(
      repairRecentRepliersAfterPostDelete({
        postId: 'already-deleted',
        parentPostId: 'parent-post',
      }),
    ).resolves.toEqual([]);

    expect(mocks.warn).toHaveBeenCalledWith(
      '[PostRecentReplier] Failed to repair projection after post deletion',
      expect.objectContaining({
        postId: 'already-deleted',
        parentPostId: 'parent-post',
        reason: 'Mongo unavailable',
      }),
    );
  });
});
