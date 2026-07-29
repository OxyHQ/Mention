import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sweep that finds the reports the pipeline lost sight of.
 *
 * The outbox makes delivery durable, not infallible: a report written before this
 * integration existed, or one whose event expired while the deployment was down, has
 * nothing to deliver it. This sweep RE-DERIVES that work from the reports and never
 * invents any — the guarantee being tested is that it enqueues only what is missing,
 * with the same deterministic id, so a report that already has an event is untouched
 * rather than delivered twice.
 */

type Doc = Record<string, unknown>;

let reports: Doc[];
let outbox: Doc[];
let submittedLongAgo: number;

vi.mock('../../../models/Report.model', async () => {
  const actual = await vi.importActual<typeof import('../../../models/Report.model')>(
    '../../../models/Report.model',
  );
  return {
    ...actual,
    default: {
      find: vi.fn(() => {
        const query = {
          select: () => query,
          sort: () => query,
          limit: () => query,
          lean: async () => reports.map((report) => ({ ...report })),
        };
        return query;
      }),
      countDocuments: vi.fn(async () => submittedLongAgo),
    },
  };
});

vi.mock('../../../models/ModerationOutbox', () => ({
  MODERATION_OUTBOX_RETENTION_SECONDS: 90 * 24 * 60 * 60,
  default: {
    findById: vi.fn((id: string) => {
      const found = outbox.find((doc) => doc._id === id);
      const query = {
        select: () => query,
        lean: async () => (found ? { ...found } : null),
      };
      return query;
    }),
    updateOne: vi.fn(async (filter: Doc, update: Doc) => {
      if (!outbox.some((doc) => doc._id === filter._id)) {
        outbox.push({ ...((update.$setOnInsert as Doc | undefined) ?? {}) });
      }
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 1 };
    }),
  },
}));

import ModerationOutbox from '../../../models/ModerationOutbox';
import { reconcileModerationReports } from '../../../services/moderation/ModerationReconciliation';
import { reportSubmitEventId } from '../../../services/moderation/ModerationOutboxService';

const REPORT_A = '507f1f77bcf86cd799439011';
const REPORT_B = '507f1f77bcf86cd799439022';

describe('moderation reconciliation', () => {
  beforeEach(() => {
    reports = [];
    outbox = [];
    submittedLongAgo = 0;
    vi.clearAllMocks();
    vi.spyOn(mongoose, 'startSession').mockResolvedValue({
      // `inTransaction()` is what `enqueueModerationOutboxEvent` checks. A stub
      // without it would make the guard fire and hide the behaviour under test.
      inTransaction: () => true,
      withTransaction: vi.fn(async (operation: () => Promise<void>) => {
        await operation();
      }),
      endSession: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('re-derives a missing delivery event with the same deterministic id', async () => {
    reports = [{ _id: new mongoose.Types.ObjectId(REPORT_A), localStatus: 'queued' }];

    const result = await reconcileModerationReports();

    expect(result.requeued).toBe(1);
    expect(outbox).toHaveLength(1);
    /**
     * The SAME id the intake would have used. A sweep that minted a new one would
     * deliver the report twice — and because the SDK's idempotency key is derived from
     * the report, the second delivery would arrive under a different key and open a
     * second case.
     */
    expect(outbox[0]).toMatchObject({
      _id: reportSubmitEventId(REPORT_A),
      kind: 'report.submit',
      payload: { reportId: REPORT_A },
    });
  });

  it('leaves a report that already has an event alone', async () => {
    reports = [{ _id: new mongoose.Types.ObjectId(REPORT_A), localStatus: 'queued' }];
    outbox = [{ _id: reportSubmitEventId(REPORT_A), status: 'pending' }];

    const result = await reconcileModerationReports();

    expect(result.requeued).toBe(0);
    expect(ModerationOutbox.updateOne).not.toHaveBeenCalled();
  });

  it('counts a dead-lettered event instead of spinning on it', async () => {
    reports = [{ _id: new mongoose.Types.ObjectId(REPORT_A), localStatus: 'delivery_failed' }];
    outbox = [{ _id: reportSubmitEventId(REPORT_A), status: 'dead_letter' }];

    const result = await reconcileModerationReports();

    /**
     * Something about the payload has to change before this can succeed, so re-queueing
     * it would spin forever. The COUNT is the alert — the sweep's job here is to make
     * the report visible, not to retry it.
     */
    expect(result.deadLettered).toBe(1);
    expect(result.requeued).toBe(0);
    expect(ModerationOutbox.updateOne).not.toHaveBeenCalled();
  });

  it('writes the re-derived event inside a transaction', async () => {
    reports = [{ _id: new mongoose.Types.ObjectId(REPORT_B), localStatus: 'queued' }];

    await reconcileModerationReports();

    /**
     * Not for atomicity — it is a single upsert. `enqueueModerationOutboxEvent`
     * REQUIRES a session so that no path in the codebase can write an outbox event
     * outside one; a signature that made it optional would be the crack the next caller
     * slips through.
     */
    expect(mongoose.startSession).toHaveBeenCalled();
    const options = vi.mocked(ModerationOutbox.updateOne).mock.calls[0][2];
    expect(options?.session).toBeDefined();
  });

  it('reports how many submitted cases have gone quiet', async () => {
    submittedLongAgo = 7;

    const result = await reconcileModerationReports();

    // Nothing to do locally — publishing the decision is CrowdSource's job — but a
    // rising count is how a broken endpoint or a rotated secret becomes visible before
    // somebody notices a silent moderation queue.
    expect(result.awaitingDecision).toBe(7);
  });
});
