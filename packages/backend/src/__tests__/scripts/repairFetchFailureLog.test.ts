import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The per-post re-fetch failure log.
 *
 * It exists because a sweep's candidate filter cannot select the RETRYABLE tail:
 * measured on the real corpus, 5,691 transient failures sat inside 46,291
 * candidates, so retrying them through the filter meant ~40,600 requests to
 * other people's servers that could not produce a repair. What is pinned here is
 * the write contract that makes the targeted alternative possible — and the
 * never-throw policy, since a bookkeeping blip must not kill a six-hour sweep.
 */
const mocks = vi.hoisted(() => ({ bulkWrite: vi.fn() }));

vi.mock('../../models/RepairFetchFailure', () => ({
  RepairFetchFailure: { bulkWrite: mocks.bulkWrite },
}));

import { recordRepairFetchFailures } from '../../scripts/lib/repairFetchFailureLog';
import { logger } from '../../utils/logger';

const SCRIPT = 'repairFederatedMentions';
const POST_ID = '65fdc8c8c8c8c8c8c8c8c8c8';

interface UpsertOp {
  updateOne: {
    filter: { script: string; postId: string };
    update: { $set: { reason: string; status?: number; failedAt: Date } };
    upsert: boolean;
  };
}

beforeEach(() => {
  mocks.bulkWrite.mockReset().mockResolvedValue({ upsertedCount: 1 });
  vi.mocked(logger.warn).mockClear();
});

describe('recordRepairFetchFailures', () => {
  it('upserts one row per post, keyed on script and post', async () => {
    await expect(
      recordRepairFetchFailures(SCRIPT, [{ postId: POST_ID, reason: 'httpStatus', status: 429 }]),
    ).resolves.toBe(true);

    const [ops, options] = mocks.bulkWrite.mock.calls[0] as [UpsertOp[], { ordered: boolean }];
    expect(ops).toEqual([{
      updateOne: {
        filter: { script: SCRIPT, postId: POST_ID },
        update: { $set: { reason: 'httpStatus', status: 429, failedAt: expect.any(Date) } },
        upsert: true,
      },
    }]);
    // Upsert, not insert: the collection stays bounded by DISTINCT failing posts
    // however many times the sweep runs.
    expect(options).toEqual({ ordered: false });
  });

  it('writes nothing when there is nothing to write', async () => {
    await expect(recordRepairFetchFailures(SCRIPT, [])).resolves.toBe(true);

    // An empty `bulkWrite` is an illegal operation, so this has to stay a guard.
    expect(mocks.bulkWrite).not.toHaveBeenCalled();
  });

  it('stamps one timestamp across the batch', async () => {
    await recordRepairFetchFailures(SCRIPT, [
      { postId: POST_ID, reason: 'transport' },
      { postId: '65fdc8c8c8c8c8c8c8c8c8c9', reason: 'timeout' },
    ]);

    const [ops] = mocks.bulkWrite.mock.calls[0] as [UpsertOp[]];
    expect(ops[0].updateOne.update.$set.failedAt)
      .toEqual(ops[1].updateOne.update.$set.failedAt);
  });

  it('reports a failed write instead of throwing, and never logs a post id', async () => {
    mocks.bulkWrite.mockRejectedValue(new Error('connection reset by peer'));

    // A blip must not kill a sweep that is otherwise repairing posts correctly;
    // the caller counts the miss and fails the run at the end.
    await expect(
      recordRepairFetchFailures(SCRIPT, [{ postId: POST_ID, reason: 'transport' }]),
    ).resolves.toBe(false);

    const [message, context] = vi.mocked(logger.warn).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(message).toContain('could not record re-fetch failures');
    expect(context.count).toBe(1);
    expect(JSON.stringify(context)).not.toContain(POST_ID);
  });
});
