import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The resume-cursor store shared by every long-running administrative sweep.
 *
 * These scripts only ever run as one-shot Fargate tasks, so a cursor on the
 * container filesystem dies with the task, and CloudWatch cannot hold one either
 * — the backend logger rewrites every 24-hex ObjectId to `[REDACTED]` and
 * redacts any key ending in `id` (covered by
 * `__tests__/utils/loggerSanitization.test.ts`). MongoDB is the only durable
 * place a sweep already has, so what is pinned here is the read/write/clear
 * contract every sweep depends on to be resumable at all.
 */
const mocks = vi.hoisted(() => ({
  findOne: vi.fn(),
  updateOne: vi.fn(),
  deleteOne: vi.fn(),
}));

vi.mock('../../models/AdminScriptCursor', () => ({
  AdminScriptCursor: {
    findOne: mocks.findOne,
    updateOne: mocks.updateOne,
    deleteOne: mocks.deleteOne,
  },
}));

import {
  clearAdminScriptCursor,
  readAdminScriptCursor,
  recordAdminScriptCursor,
} from '../../scripts/lib/adminScriptCursor';
import { logger } from '../../utils/logger';

const SCRIPT = 'repairFederatedMentions';
const SCOPE = 'after:|before:|actor:';
const CURSOR = '65fdc8c8c8c8c8c8c8c8c8c8';

/** `findOne(...).lean()` resolving to `row`. */
function leanResult(row: unknown): { lean: () => Promise<unknown> } {
  return { lean: async () => row };
}

beforeEach(() => {
  mocks.findOne.mockReset();
  mocks.updateOne.mockReset().mockResolvedValue({ acknowledged: true });
  mocks.deleteOne.mockReset().mockResolvedValue({ deletedCount: 1 });
  vi.mocked(logger.warn).mockClear();
});

describe('readAdminScriptCursor', () => {
  it('returns null for a scope that has never run', async () => {
    mocks.findOne.mockReturnValue(leanResult(null));

    await expect(readAdminScriptCursor(SCRIPT, SCOPE)).resolves.toBeNull();
    expect(mocks.findOne).toHaveBeenCalledWith(
      { script: SCRIPT, scope: SCOPE },
      { cursor: 1, scanned: 1, completedAt: 1 },
    );
  });

  it('reports where the scope got to, and whether it finished', async () => {
    const completedAt = new Date('2026-08-01T15:46:38Z');
    mocks.findOne.mockReturnValue(leanResult({ cursor: CURSOR, scanned: 30_000, completedAt }));

    await expect(readAdminScriptCursor(SCRIPT, SCOPE)).resolves.toEqual({
      cursor: CURSOR,
      scanned: 30_000,
      completedAt,
    });
  });

  it('normalizes a legacy row with no completion stamp to "not finished"', async () => {
    mocks.findOne.mockReturnValue(leanResult({ cursor: CURSOR, scanned: 1 }));

    await expect(readAdminScriptCursor(SCRIPT, SCOPE)).resolves.toMatchObject({
      completedAt: null,
    });
  });

  it('propagates a read failure instead of degrading to "never ran"', async () => {
    // Swallowing this would silently restart the sweep from the beginning —
    // the exact failure the cursor exists to prevent.
    mocks.findOne.mockReturnValue({ lean: async () => { throw new Error('no primary'); } });

    await expect(readAdminScriptCursor(SCRIPT, SCOPE)).rejects.toThrow('no primary');
  });
});

describe('recordAdminScriptCursor', () => {
  it('upserts the scope\'s progress and reports that the write landed', async () => {
    await expect(
      recordAdminScriptCursor(SCRIPT, SCOPE, { cursor: CURSOR, scanned: 500 }),
    ).resolves.toBe(true);

    expect(mocks.updateOne).toHaveBeenCalledWith(
      { script: SCRIPT, scope: SCOPE },
      { $set: { cursor: CURSOR, scanned: 500, completedAt: null } },
      { upsert: true },
    );
  });

  it('stamps a completion time only when the range was exhausted', async () => {
    await recordAdminScriptCursor(SCRIPT, SCOPE, {
      cursor: CURSOR,
      scanned: 500,
      completed: true,
    });

    const [, update] = mocks.updateOne.mock.calls[0] as [
      unknown,
      { $set: { completedAt: Date | null } },
    ];
    expect(update.$set.completedAt).toBeInstanceOf(Date);
  });

  it('clears an earlier completion stamp when the scope has more work', async () => {
    // A scope that gained new candidates after finishing must not keep reading
    // as finished, or the next operator sees "nothing to do" and believes it.
    await recordAdminScriptCursor(SCRIPT, SCOPE, { cursor: CURSOR, scanned: 900 });

    const [, update] = mocks.updateOne.mock.calls[0] as [
      unknown,
      { $set: { completedAt: Date | null } },
    ];
    expect(update.$set.completedAt).toBeNull();
  });

  it('reports a failed write instead of throwing, and never logs the cursor', async () => {
    mocks.updateOne.mockRejectedValue(new Error('connection reset by peer'));

    // A transient blip must not kill a sweep that is otherwise doing its work
    // correctly; the caller counts the miss and fails the run at the end.
    await expect(
      recordAdminScriptCursor(SCRIPT, SCOPE, { cursor: CURSOR, scanned: 500 }),
    ).resolves.toBe(false);

    const [message, context] = vi.mocked(logger.warn).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(message).toContain('could not persist the resume cursor');
    expect(JSON.stringify(context)).not.toContain(CURSOR);
  });
});

describe('clearAdminScriptCursor', () => {
  it('forgets the scope\'s progress', async () => {
    await clearAdminScriptCursor(SCRIPT, SCOPE);

    expect(mocks.deleteOne).toHaveBeenCalledWith({ script: SCRIPT, scope: SCOPE });
  });

  it('propagates a failed clear rather than resuming anyway', async () => {
    // This only ever runs because an operator asked for a fresh start. Resuming
    // after failing to honour that would be a silent lie about what ran.
    mocks.deleteOne.mockRejectedValue(new Error('not authorized'));

    await expect(clearAdminScriptCursor(SCRIPT, SCOPE)).rejects.toThrow('not authorized');
  });
});
