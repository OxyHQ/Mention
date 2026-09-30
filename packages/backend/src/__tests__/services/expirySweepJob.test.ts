/**
 * The schedule around the expiry sweep (OxyHQ/Mention#1187).
 *
 * The deletes themselves are proven against real rows in `db/expiry.test.ts`.
 * This file holds what the job adds on top: every scheduled target is swept
 * each run, `engagement_outbox` goes through the processed-only sweep, and one
 * table's failure does not stop the rest.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import type { ExpirySweepResult, ExpirySweepTarget } from '@oxy.so/db/expiry';

const { sweepExpiredRowsMock, sweepOutboxMock } = vi.hoisted(() => ({
  sweepExpiredRowsMock: vi.fn(),
  sweepOutboxMock: vi.fn(),
}));

vi.mock('@oxy.so/db/expiry', () => ({ sweepExpiredRows: sweepExpiredRowsMock }));
vi.mock('../../db/postgres', () => ({ getDb: () => ({}) }));
vi.mock('../../db/expiry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/expiry')>()),
  sweepProcessedEngagementOutbox: sweepOutboxMock,
}));

import { SCHEDULED_EXPIRY_SWEEP_TARGETS } from '../../db/expiry';
import { ExpirySweepJob } from '../../services/ExpirySweepJob';

function done(table: string, deleted = 0): ExpirySweepResult {
  return { table, deleted, truncated: false };
}

afterEach(() => {
  sweepExpiredRowsMock.mockReset();
  sweepOutboxMock.mockReset();
});

describe('ExpirySweepJob.runSweep', () => {
  it('sweeps every scheduled target and the processed outbox', async () => {
    sweepExpiredRowsMock.mockImplementation(async (_db: unknown, target: ExpirySweepTarget) =>
      done(getTableName(target.table), 3)
    );
    sweepOutboxMock.mockResolvedValue(done('engagement_outbox', 2));

    const results = await new ExpirySweepJob().runSweep();

    const swept = sweepExpiredRowsMock.mock.calls.map(([, target]) =>
      getTableName((target as ExpirySweepTarget).table)
    );
    expect(swept).toEqual(SCHEDULED_EXPIRY_SWEEP_TARGETS.map((t) => getTableName(t.table)));
    expect(swept).not.toContain('engagement_outbox');
    expect(sweepOutboxMock).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.table)).toContain('engagement_outbox');
    expect(results).toHaveLength(SCHEDULED_EXPIRY_SWEEP_TARGETS.length + 1);
  });

  it('keeps sweeping after one table fails', async () => {
    const failing = getTableName(SCHEDULED_EXPIRY_SWEEP_TARGETS[0]!.table);
    sweepExpiredRowsMock.mockImplementation(async (_db: unknown, target: ExpirySweepTarget) => {
      const table = getTableName(target.table);
      if (table === failing) throw new Error('lock timeout');
      return done(table);
    });
    sweepOutboxMock.mockResolvedValue(done('engagement_outbox'));

    const results = await new ExpirySweepJob().runSweep();

    expect(results.map((result) => result.table)).not.toContain(failing);
    expect(results).toHaveLength(SCHEDULED_EXPIRY_SWEEP_TARGETS.length);
    expect(sweepOutboxMock).toHaveBeenCalledTimes(1);
  });

  it('skips a tick while the previous run is still sweeping', async () => {
    let release!: () => void;
    sweepExpiredRowsMock.mockImplementationOnce(
      () =>
        new Promise<ExpirySweepResult>((resolve) => {
          release = () => resolve(done('first'));
        })
    );
    sweepExpiredRowsMock.mockResolvedValue(done('rest'));
    sweepOutboxMock.mockResolvedValue(done('engagement_outbox'));

    const job = new ExpirySweepJob();
    const first = job.runSweep();
    await expect(job.runSweep()).resolves.toEqual([]);
    release();
    await first;
    expect(sweepOutboxMock).toHaveBeenCalledTimes(1);
  });
});
