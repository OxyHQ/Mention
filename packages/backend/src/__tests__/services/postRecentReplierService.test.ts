import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateOne, find, rows } = vi.hoisted(() => ({
  updateOne: vi.fn(),
  find: vi.fn(),
  rows: new Map<string, Array<{ oxyUserId: string; repliedAt: Date }>>(),
}));

vi.mock('../../models/PostRecentReplier', () => ({
  POST_RECENT_REPLIER_LIMIT: 3,
  PostRecentReplier: {
    updateOne: (...args: unknown[]) => updateOne(...args),
    find: (...args: unknown[]) => find(...args),
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  loadRecentReplierIds,
  mergeRecentRepliers,
  recordRecentReplierForPost,
} from '../../services/PostRecentReplierService';

type UpdateStage = {
  $set: {
    createdAt: { $ifNull: [string, Date] };
    repliers: {
      $let: {
        in: {
          $let: {
            in: {
              $slice: [
                {
                  $concatArrays: [
                    unknown,
                    Array<{ oxyUserId: string; repliedAt: string }>,
                    unknown,
                  ];
                },
                number,
              ];
            };
          };
        };
      };
    };
  };
};

describe('PostRecentReplierService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rows.clear();

    updateOne.mockImplementation(
      async (
        filter: { postId: string },
        pipeline: UpdateStage[],
      ) => {
        const stage = pipeline[0];
        const concat = stage.$set.repliers.$let.in.$let.in.$slice[0].$concatArrays;
        const oxyUserId = concat[1][0].oxyUserId;
        const repliedAt = stage.$set.createdAt.$ifNull[1];
        rows.set(
          filter.postId,
          mergeRecentRepliers(rows.get(filter.postId) ?? [], { oxyUserId, repliedAt }),
        );
        return { matchedCount: 1 };
      },
    );

    find.mockImplementation((filter: { postId: { $in: string[] } }) => {
      const query = {
        select: vi.fn(() => query),
        lean: vi.fn(async () =>
          filter.postId.$in
            .filter((postId) => rows.has(postId))
            .map((postId) => ({ postId, repliers: rows.get(postId) })),
        ),
      };
      return query;
    });
  });

  it('keeps exactly the three newest unique public repliers for a string parent id', async () => {
    const parentPostId = '65f012345678901234567890';
    const record = (oxyUserId: string, createdAt: string) =>
      recordRecentReplierForPost({
        parentPostId,
        oxyUserId,
        createdAt,
        visibility: 'public',
        status: 'published',
      });

    await record('alice', '2026-01-01T10:00:00.000Z');
    await record('bob', '2026-01-01T09:00:00.000Z');
    await record('alice', '2026-01-01T11:00:00.000Z');
    await record('carol', '2026-01-01T08:00:00.000Z');
    await record('dave', '2026-01-01T10:30:00.000Z');

    const projection = await loadRecentReplierIds([parentPostId]);

    expect(projection.perPostRepliers.get(parentPostId)).toEqual([
      'alice',
      'dave',
      'bob',
    ]);
    expect([...projection.allReplierIds]).toEqual(['alice', 'dave', 'bob']);
    expect(new Set(projection.perPostRepliers.get(parentPostId)).size).toBe(3);
    expect(updateOne.mock.calls[0][0]).toEqual({ postId: parentPostId });

    const serializedPipeline = JSON.stringify(updateOne.mock.calls[0][1]);
    expect(serializedPipeline).toContain('"$slice"');
    expect(serializedPipeline).toContain(',3]');
  });

  it('does not let an older out-of-order reply demote a newer entry from the same user', async () => {
    const parentPostId = 'parent-string';
    await recordRecentReplierForPost({
      parentPostId,
      oxyUserId: 'alice',
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    await recordRecentReplierForPost({
      parentPostId,
      oxyUserId: 'alice',
      createdAt: '2025-01-02T00:00:00.000Z',
    });

    expect(rows.get(parentPostId)).toEqual([
      { oxyUserId: 'alice', repliedAt: new Date('2026-01-02T00:00:00.000Z') },
    ]);
  });

  it('excludes private and unpublished replies from the projection', async () => {
    await recordRecentReplierForPost({
      parentPostId: 'parent',
      oxyUserId: 'private-user',
      visibility: 'private',
      status: 'published',
    });
    await recordRecentReplierForPost({
      parentPostId: 'parent',
      oxyUserId: 'scheduled-user',
      visibility: 'public',
      status: 'scheduled',
    });

    expect(updateOne).not.toHaveBeenCalled();
  });
});
