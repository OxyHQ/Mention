import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The report that survives CrowdSource being down.
 *
 * This is the test the whole durable-reception design exists to make passable: the
 * user is answered, CrowdSource is unreachable, and the report is delivered later
 * without anybody re-filing it. It is written as two dispatcher ticks against an
 * in-memory outbox rather than as assertions on mock calls, because the property is
 * about what SURVIVES between the two — an assertion that
 * `reports.create` was called twice would pass just as well if the second call had
 * come from a caller re-submitting by hand.
 *
 * The fake below implements only the operators the outbox service actually issues.
 * That is deliberate: a general Mongo emulator would let a claim succeed that the
 * real owner-checked `updateOne` would refuse, and the lease semantics are the part
 * worth being sure about.
 */

type Doc = Record<string, unknown>;

/** The comparison operators `ModerationOutboxService` builds. Nothing else. */
function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$or') {
      return (
        Array.isArray(condition) &&
        condition.some((sub) => matches(doc, sub as Doc))
      );
    }
    const value = doc[key];
    if (
      typeof condition === 'object' &&
      condition !== null &&
      !(condition instanceof Date) &&
      !Array.isArray(condition)
    ) {
      const operators = condition as Record<string, unknown>;
      if ('$lte' in operators) {
        return value instanceof Date && value.getTime() <= (operators.$lte as Date).getTime();
      }
      if ('$gt' in operators) {
        return value instanceof Date && value.getTime() > (operators.$gt as Date).getTime();
      }
      if ('$exists' in operators) {
        return operators.$exists === true ? value !== undefined : value === undefined;
      }
      if ('$in' in operators) {
        return Array.isArray(operators.$in) && operators.$in.includes(value);
      }
    }
    return value === condition;
  });
}

function applyUpdate(doc: Doc, update: Doc): void {
  const set = update.$set as Doc | undefined;
  if (set) Object.assign(doc, set);
  const inc = update.$inc as Record<string, number> | undefined;
  if (inc) {
    for (const [key, delta] of Object.entries(inc)) {
      doc[key] = ((doc[key] as number | undefined) ?? 0) + delta;
    }
  }
  const unset = update.$unset as Doc | undefined;
  if (unset) {
    for (const key of Object.keys(unset)) delete doc[key];
  }
}

/** The in-memory outbox collection, shared by the model mock below. */
const outbox: Doc[] = [];

vi.mock('../../../models/ModerationOutbox', () => ({
  MODERATION_OUTBOX_RETENTION_SECONDS: 90 * 24 * 60 * 60,
  default: {
    findOneAndUpdate: vi.fn((filter: Doc, update: Doc) => {
      const target = outbox.find((doc) => matches(doc, filter));
      if (target) applyUpdate(target, update);
      const projection = {
        select: () => projection,
        lean: async () => (target ? { ...target } : null),
      };
      return projection;
    }),
    updateOne: vi.fn(async (filter: Doc, update: Doc) => {
      const target = outbox.find((doc) => matches(doc, filter));
      if (!target) return { matchedCount: 0, modifiedCount: 0 };
      applyUpdate(target, update);
      return { matchedCount: 1, modifiedCount: 1 };
    }),
    findById: vi.fn((id: string) => {
      const target = outbox.find((doc) => doc._id === id);
      const projection = {
        select: () => projection,
        lean: async () => (target ? { ...target } : null),
      };
      return projection;
    }),
  },
}));

/** The report, and the updates the delivery worker writes to it. */
const report: Doc = {};

vi.mock('../../../models/Report.model', async () => {
  const actual = await vi.importActual<typeof import('../../../models/Report.model.js')>(
    '../../../models/Report.model',
  );
  return {
    ...actual,
    default: {
      findById: vi.fn(() => ({
        lean: async () => ({ ...report }),
      })),
      updateOne: vi.fn(async (_filter: Doc, update: Doc) => {
        applyUpdate(report, update);
        return { matchedCount: 1, modifiedCount: 1 };
      }),
    },
  };
});

/** The subject snapshot. The seam is exercised elsewhere; here it just resolves. */
vi.mock('../../../services/moderation/subjects/registry', async () => {
  const actual = await vi.importActual<
    typeof import('../../../services/moderation/subjects/registry.js')
  >('../../../services/moderation/subjects/registry');
  return {
    ...actual,
    subjectProviderFor: vi.fn(() => ({
      reportedType: 'post',
      subjectType: 'social.post',
      snapshot: async () => ({
        subject: {
          externalId: '507f1f77bcf86cd799439022',
          type: 'social.post',
          author: { oxyUserId: 'oxy-author' },
        },
        content: 'The exact reported text.',
      }),
    })),
  };
});

const reportsCreate = vi.fn();

vi.mock('../../../services/moderation/crowdSourceClient', () => ({
  getCrowdSourceClient: vi.fn(() => ({ reports: { create: reportsCreate } })),
  resetCrowdSourceClient: vi.fn(),
}));

import ModerationOutbox from '../../../models/ModerationOutbox';
import Report from '../../../models/Report.model';
import { ReportCategory, ReportedType } from '../../../models/Report.model';
import {
  dispatchModerationOutbox,
  reportSubmitEventId,
} from '../../../services/moderation/ModerationOutboxService';
import { handleModerationOutboxEvent } from '../../../services/moderation/ModerationOutboxDispatcher';

const REPORT_ID = '507f1f77bcf86cd799439011';
const EVENT_ID = reportSubmitEventId(REPORT_ID);

/**
 * The error shape `@oxyhq/crowdsource` throws for "come back later": a 503 or a
 * connection failure. `retryable` is the only field the outbox reads.
 */
class RetryableTransportError extends Error {
  readonly retryable = true;

  constructor() {
    super('The request to /v1/reports did not complete.');
    this.name = 'CrowdSourceTransportError';
  }
}

/** The 409 of §10.5: the same external id with a different body. Never retryable. */
class PayloadConflictError extends Error {
  readonly retryable = false;

  constructor() {
    super('CrowdSource answered 409 for /v1/reports.');
    this.name = 'CrowdSourceApiError';
  }
}

function seed(): void {
  outbox.length = 0;
  outbox.push({
    _id: EVENT_ID,
    kind: 'report.submit',
    payload: { reportId: REPORT_ID },
    status: 'pending',
    attempts: 0,
    availableAt: new Date(Date.now() - 1_000),
    expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000),
    createdAt: new Date(),
  });

  for (const key of Object.keys(report)) delete report[key];
  Object.assign(report, {
    _id: new mongoose.Types.ObjectId(REPORT_ID),
    reportedType: ReportedType.POST,
    reportedId: '507f1f77bcf86cd799439022',
    reporter: 'oxy-user-reporter',
    categories: [ReportCategory.HARASSMENT],
    localStatus: 'queued',
    createdAt: new Date('2026-07-28T18:00:00.000Z'),
  });
}

async function tick(): Promise<{ processed: number; failed: number; deadLettered: number }> {
  return await dispatchModerationOutbox({
    handler: handleModerationOutboxEvent,
    batchSize: 10,
  });
}

/** Make the event due again, as the passage of real time would. */
function fastForwardPastBackoff(): void {
  const event = outbox[0];
  event.availableAt = new Date(Date.now() - 1_000);
}

describe('moderation outbox — delivery survives CrowdSource being unreachable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the report and delivers it on a later tick', async () => {
    reportsCreate
      .mockRejectedValueOnce(new RetryableTransportError())
      .mockResolvedValueOnce({
        reportId: 'rpt_01',
        caseId: 'case_01',
        status: 'received',
        merged: false,
      });

    // --- Tick 1: CrowdSource is unreachable.
    const first = await tick();

    expect(first.processed).toBe(0);
    expect(first.failed).toBe(1);
    expect(first.deadLettered).toBe(0);

    // The event survived, is due in the future, and remembers the failure.
    const afterFailure = outbox[0];
    expect(afterFailure.status).toBe('pending');
    expect(afterFailure.attempts).toBe(1);
    expect((afterFailure.availableAt as Date).getTime()).toBeGreaterThan(Date.now());
    expect(afterFailure.lastError).toContain('did not complete');
    // No lease is held, so any task can pick it up next.
    expect(afterFailure.leaseOwner).toBeUndefined();

    // The failure is visible on the report itself, not only in the outbox.
    expect(report.localStatus).toBe('delivery_failed');
    expect(report.crowdSourceCaseId).toBeUndefined();

    // --- Tick 2: CrowdSource is back.
    fastForwardPastBackoff();
    const second = await tick();

    expect(second.processed).toBe(1);
    expect(second.failed).toBe(0);

    // The SAME event completed — no second event was ever created, so the
    // idempotency key CrowdSource sees is the same one it saw before.
    expect(outbox).toHaveLength(1);
    expect(outbox[0]._id).toBe(EVENT_ID);
    expect(outbox[0].status).toBe('processed');

    expect(report.localStatus).toBe('submitted');
    expect(report.crowdSourceReportId).toBe('rpt_01');
    expect(report.crowdSourceCaseId).toBe('case_01');
    expect(report.contentSnapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The failure note is cleared rather than left to be read as current.
    expect(report.lastDeliveryError).toBeUndefined();

    expect(reportsCreate).toHaveBeenCalledTimes(2);
  });

  it('sends the same submittedAt on every attempt, so a retry is not a 409', async () => {
    reportsCreate
      .mockRejectedValueOnce(new RetryableTransportError())
      .mockResolvedValueOnce({
        reportId: 'rpt_01',
        caseId: 'case_01',
        status: 'received',
        merged: false,
      });

    await tick();
    fastForwardPastBackoff();
    await tick();

    /**
     * §10.5 answers 409 when one `externalReportId` arrives with a different body,
     * and ingress fingerprints the WHOLE envelope. A timestamp invented per attempt
     * would therefore turn every legitimate retry into a permanent conflict — days
     * later, as moderation work stuck in a queue. Both attempts must be byte-equal.
     */
    const [firstAttempt] = reportsCreate.mock.calls[0];
    const [secondAttempt] = reportsCreate.mock.calls[1];
    expect(secondAttempt).toEqual(firstAttempt);
    expect(firstAttempt.submittedAt).toEqual(report.createdAt);
    expect(firstAttempt.externalReportId).toBe(REPORT_ID);
  });

  it('stops trying when the failure says a retry can never succeed', async () => {
    reportsCreate.mockRejectedValue(new PayloadConflictError());

    const result = await tick();

    expect(result.deadLettered).toBe(1);
    /**
     * Dead-lettered on the FIRST attempt, not after twenty-five. No number of
     * retries makes two different payloads one report, so the attempt count would
     * only bury the reason in a growing row nobody reads.
     */
    expect(outbox[0].status).toBe('dead_letter');
    expect(outbox[0].attempts).toBe(1);
    expect(outbox[0].lastError).toContain('409');

    // Still due immediately rather than backed off: the event is not waiting for
    // time to pass, it is waiting for a person.
    expect((outbox[0].availableAt as Date).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('leaves the event untouched when there is nowhere to deliver to', async () => {
    const { getCrowdSourceClient } = await import(
      '../../../services/moderation/crowdSourceClient'
    );
    vi.mocked(getCrowdSourceClient).mockReturnValueOnce(undefined);

    const result = await tick();

    expect(result.failed).toBe(1);
    expect(result.deadLettered).toBe(0);
    // An unconfigured deployment is a DELAY. The report keeps its durable event and
    // delivers when the integration is switched on.
    expect(outbox[0].status).toBe('pending');
    expect(reportsCreate).not.toHaveBeenCalled();
  });

  it('never claims an event a second time while its lease is live', async () => {
    /**
     * The claim, not the loop, is what makes running this on every ECS task safe. A
     * held lease must be invisible to a second dispatcher — otherwise two tasks
     * deliver one report concurrently and only the SDK's idempotency key stands
     * between that and two cases.
     */
    reportsCreate.mockImplementation(async () => {
      // While this delivery is in flight, a second dispatcher finds nothing to do.
      const concurrent = await tick();
      expect(concurrent.processed).toBe(0);
      expect(concurrent.failed).toBe(0);
      return { reportId: 'rpt_01', caseId: 'case_01', status: 'received', merged: false };
    });

    const result = await tick();

    expect(result.processed).toBe(1);
    expect(reportsCreate).toHaveBeenCalledTimes(1);
  });
});

describe('moderation outbox — model contract the fake stands in for', () => {
  it('claims with an owner-checked lease and orders oldest-first', async () => {
    /**
     * A vacuity floor. Every assertion above runs against the fake, so if the
     * service stopped issuing owner-checked updates — or stopped sorting — the fake
     * would happily keep passing. This pins the SHAPE of what the service asks Mongo
     * for, which is the part the fake cannot verify for itself.
     */
    seed();
    reportsCreate.mockResolvedValue({
      reportId: 'rpt_01',
      caseId: 'case_01',
      status: 'received',
      merged: false,
    });

    await tick();

    expect(ModerationOutbox.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        $or: [
          { status: 'pending', availableAt: { $lte: expect.any(Date) } },
          { status: 'processing', leaseUntil: { $lte: expect.any(Date) } },
        ],
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'processing', leaseOwner: expect.any(String) }),
        $inc: { attempts: 1 },
      }),
      expect.objectContaining({ new: true, sort: { createdAt: 1 } }),
    );

    // Completion is owner-checked and lease-checked, so a dispatcher that lost its
    // lease cannot mark somebody else's work processed.
    expect(ModerationOutbox.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: EVENT_ID,
        status: 'processing',
        leaseOwner: expect.any(String),
        leaseUntil: { $gt: expect.any(Date) },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'processed' }),
      }),
    );

    expect(Report.updateOne).toHaveBeenCalled();
  });
});
