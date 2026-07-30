import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decisionFixture } from '@oxyhq/crowdsource-testing';

/**
 * Applying a decision to the reports that opened the case.
 *
 * §15.6's definition of done in one place: a decision comes back signed, Mention
 * updates its state, and Mention does not delete content. The other property under
 * test is "one penalty per incident" — a hundred reports about the same material
 * produce one case and ONE consequence, so enforcement is called once no matter how
 * many report rows the case covers.
 */

type Doc = Record<string, unknown>;

/** The reports linked to the case, and the updates the worker writes. */
let reports: Doc[];
let updates: Array<{ filter: Doc; update: Doc }>;

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
          lean: async () => reports.map((report) => ({ ...report })),
        };
        return query;
      }),
      updateOne: vi.fn(async (filter: Doc, update: Doc) => {
        updates.push({ filter, update });
        /**
         * The revision guard lives in the FILTER, so the fake has to honour it or the
         * test would prove nothing about staleness. `$or` here is exactly the two
         * branches the worker builds.
         */
        const target = reports.find((report) => report._id === filter._id);
        if (!target) return { matchedCount: 0, modifiedCount: 0 };
        const guard = filter.$or as Array<Doc> | undefined;
        if (guard) {
          const stored = target.decisionRevision as number | undefined;
          const allowed = guard.some((branch) => {
            const exists = (branch.decisionRevision as Doc | undefined)?.$exists;
            if (exists === false) return stored === undefined;
            const lte = (branch.decisionRevision as Doc | undefined)?.$lte as
              | number
              | undefined;
            return lte !== undefined && stored !== undefined && stored <= lte;
          });
          if (!allowed) return { matchedCount: 0, modifiedCount: 0 };
        }
        Object.assign(target, (update.$set as Doc | undefined) ?? {});
        return { matchedCount: 1, modifiedCount: 1 };
      }),
    },
  };
});

const applyDecisionEnforcement = vi.fn();

vi.mock('../../../services/moderation/ModerationEnforcementService', () => ({
  applyDecisionEnforcement: (...args: unknown[]) => applyDecisionEnforcement(...args),
}));

import { ReportStatus, ReportedType } from '../../../models/Report.model';
import {
  ModerationDecisionDeferredError,
  ModerationDecisionRejectedError,
  applyDecisionOutboxEvent,
} from '../../../services/moderation/ModerationDecisionWorker';
import type { ModerationOutboxEvent } from '../../../services/moderation/ModerationOutboxService';

const CASE_ID = 'case_test_1';
const POST_ID = '507f1f77bcf86cd799439022';

function event(decision: unknown, payload: { caseId?: string } = { caseId: CASE_ID }): ModerationOutboxEvent {
  return {
    _id: 'moderation:decision.apply:evt_1',
    kind: 'decision.apply',
    // Spread rather than `caseId: caseId ?? DEFAULT`, so a test can express an event
    // that carries NO case id at all — an explicit `undefined` argument would silently
    // pick up a default parameter instead.
    payload: { eventId: 'evt_1', decision, ...payload },
    attempts: 1,
    availableAt: new Date(),
    expiresAt: new Date(),
    createdAt: new Date(),
  };
}

function seedReports(count: number): void {
  reports = Array.from({ length: count }, (_unused, index) => ({
    _id: `report_${index + 1}`,
    reportedType: ReportedType.POST,
    reportedId: POST_ID,
    crowdSourceCaseId: CASE_ID,
    status: ReportStatus.PENDING,
    localStatus: 'submitted',
  }));
}

describe('decision worker', () => {
  beforeEach(() => {
    updates = [];
    seedReports(1);
    vi.clearAllMocks();
    applyDecisionEnforcement.mockResolvedValue([{ action: 'restrict', result: 'recorded' }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes the decision onto the report and records what Mention did', async () => {
    const decision = decisionFixture({ caseId: CASE_ID, outcome: 'violation' });

    await applyDecisionOutboxEvent(event(decision));

    expect(reports[0]).toMatchObject({
      // A violation reached a conclusion Mention can act on.
      status: ReportStatus.RESOLVED,
      // A FINAL decision closes Mention's side of the case.
      localStatus: 'closed',
      decisionId: decision.id,
      decisionRevision: 1,
      decisionOutcome: 'violation',
      decisionStatus: 'final',
      enforcedAction: 'restrict',
    });
    expect(reports[0].enforcedAt).toBeInstanceOf(Date);
    expect(reports[0].decidedAt).toEqual(new Date(decision.publishedAt));
  });

  it('enforces once for a case however many reports opened it', async () => {
    seedReports(5);
    const decision = decisionFixture({ caseId: CASE_ID, outcome: 'violation' });

    await applyDecisionOutboxEvent(event(decision));

    /**
     * "One penalty per incident." Five reporters, one case, one consequence — and the
     * subject comes from the case rather than from each report, because §7.3's dedup
     * key makes every report in a case about the same object.
     */
    expect(applyDecisionEnforcement).toHaveBeenCalledTimes(1);
    expect(applyDecisionEnforcement).toHaveBeenCalledWith({
      decision,
      caseId: CASE_ID,
      subject: { type: ReportedType.POST, id: POST_ID },
    });
    // Every report still learns the outcome.
    expect(reports.every((report) => report.decisionOutcome === 'violation')).toBe(true);
  });

  it('leaves a provisional decision open for a later revision', async () => {
    const decision = decisionFixture({
      caseId: CASE_ID,
      outcome: 'violation',
      status: 'provisional',
    });

    await applyDecisionOutboxEvent(event(decision));

    // §9.6 allows a later revision to supersede this, so closing the report now would
    // mean reopening it later — the same mistake as editing a published decision.
    expect(reports[0].localStatus).toBe('submitted');
    expect(reports[0].decisionStatus).toBe('provisional');
  });

  it('refuses to overwrite a newer revision with an older one', async () => {
    reports[0].decisionRevision = 3;
    reports[0].decisionOutcome = 'no_violation';

    const stale = decisionFixture({
      caseId: CASE_ID,
      outcome: 'violation',
      revision: 2,
      supersedesDecisionId: 'dec_old',
    });

    await applyDecisionOutboxEvent(event(stale));

    /**
     * Deliveries overlap: §10.9 retries for 24 hours and a correction can arrive while
     * the decision it supersedes is still being applied. The guard is in the update
     * FILTER, so it is the database that refuses the stale write rather than a
     * read-then-write in this process.
     */
    expect(reports[0].decisionRevision).toBe(3);
    expect(reports[0].decisionOutcome).toBe('no_violation');
    // The write was attempted and matched nothing — that is the guard working.
    expect(updates).toHaveLength(1);
  });

  it('defers when no local report is linked to the case yet', async () => {
    reports = [];
    const decision = decisionFixture({ caseId: CASE_ID });

    await expect(applyDecisionOutboxEvent(event(decision))).rejects.toBeInstanceOf(
      ModerationDecisionDeferredError,
    );

    /**
     * A real race, not a defect: CrowdSource can decide a case and deliver the webhook
     * while the 202 carrying the case id back to Mention is still being written.
     * Retryable, so the outbox backs off; dead-lettering would throw the decision away.
     */
    await expect(applyDecisionOutboxEvent(event(decision))).rejects.toMatchObject({
      retryable: true,
    });
    expect(applyDecisionEnforcement).not.toHaveBeenCalled();
  });

  it('dead-letters a decision that does not match the published contract', async () => {
    // `agreement` must equal winningVotes / decisiveVotes — the auditable trace of
    // one-person-one-vote. A document that fails it is not something to retry.
    const malformed = {
      ...decisionFixture({ caseId: CASE_ID }),
      jury: { size: 3, decisiveVotes: 3, winningVotes: 3, agreement: 0.5, specialistPresent: false },
    };

    await expect(applyDecisionOutboxEvent(event(malformed))).rejects.toBeInstanceOf(
      ModerationDecisionRejectedError,
    );
    await expect(applyDecisionOutboxEvent(event(malformed))).rejects.toMatchObject({
      retryable: false,
    });
    expect(applyDecisionEnforcement).not.toHaveBeenCalled();
  });

  it('dead-letters an event with no case id', async () => {
    await expect(
      applyDecisionOutboxEvent(event(decisionFixture(), {})),
    ).rejects.toBeInstanceOf(ModerationDecisionRejectedError);
  });

  it('never turns an absent consensus into a dismissal', async () => {
    const inconclusive = {
      ...decisionFixture({ caseId: CASE_ID }),
      outcome: 'inconclusive' as const,
      findings: [],
      recommendedActions: [],
    };

    await applyDecisionOutboxEvent(event(inconclusive));

    /**
     * A jury that reviewed the case and did not reach the threshold has said something
     * different from a jury that agreed nothing was wrong. `dismissed` here would
     * collapse the two, which is the one mapping the invariants forbid outright.
     */
    expect(reports[0].status).toBe(ReportStatus.REVIEWED);
    expect(reports[0].status).not.toBe(ReportStatus.DISMISSED);
    expect(reports[0].decisionOutcome).toBe('inconclusive');
  });
});
