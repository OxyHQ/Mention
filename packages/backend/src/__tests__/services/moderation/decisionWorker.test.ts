import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { decisionFixture } from '@oxyhq/crowdsource-testing';

/**
 * Applying a decision to the reports that opened the case.
 *
 * §15.6's definition of done in one place: a decision comes back signed, Mention
 * updates its state, and Mention does not delete content. The other property under
 * test is "one penalty per incident" — a hundred reports about the same material
 * produce one case and ONE consequence, so enforcement is called once no matter how
 * many report rows the case covers.
 *
 * ## What the Postgres port changed
 *
 * The reports are REAL ROWS. The mock this replaces had to reimplement the
 * revision guard — `$or` over "no revision yet" and "revision <= this one" —
 * because that guard lives in the update FILTER and a filter-blind double would
 * have proved nothing about staleness. Reimplementing a predicate in the test is
 * the shape that goes quietly wrong: the copy and the original can disagree, and
 * the copy is the one the assertions believe. Postgres evaluates the real
 * `WHERE` now, and `NULL <= n` being NULL — the case that would silently drop
 * the FIRST decision on every report — is answered by the database.
 *
 * `applyDecisionEnforcement` stays mocked: "enforced exactly once per case" is a
 * property of how many times it is CALLED, and its own effects have their own
 * suite.
 */

const applyDecisionEnforcement = vi.fn();

vi.mock('../../../services/moderation/ModerationEnforcementService', () => ({
  applyDecisionEnforcement: (...args: unknown[]) => applyDecisionEnforcement(...args),
}));

import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { reports as reportsTable } from '../../../db/schema/moderation';
import { findReportById } from '../../../db/moderation/reportRepository';
import {
  ModerationDecisionDeferredError,
  ModerationDecisionRejectedError,
  applyDecisionOutboxEvent,
} from '../../../services/moderation/ModerationDecisionWorker';
import type { ModerationOutboxEvent } from '../../../db/moderation/moderationOutboxRepository';

/** Namespaces every row this file writes, so a parallel file cannot collide. */
const PREFIX = 'moderation:test-decision-worker:';
/**
 * Unique per test, so `findReportsForCase` cannot see another case's rows.
 *
 * NOT built from {@link PREFIX}: the published contract constrains a case id to
 * `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`, and `decisionFixture` validates it — a
 * namespace carrying `:` or `/` is refused before the worker ever runs.
 */
let caseSeq = 0;
let CASE_ID: string;
const POST_ID = `${PREFIX}post`;

/** The ids seeded for the current test, in creation order. */
let reportIds: string[];
/**
 * A distinct reporter per row, monotonic across the file.
 *
 * `reports_reporter_reported_key` is unique on `(reporter, reported_id,
 * reported_type)` — one report per person per object — so the five reports of a
 * single case necessarily come from five different people, which is what a case
 * with five reporters IS. Mongo declared no such index, so the old fixture could
 * mint five rows from one reporter.
 */
let reporterSeq = 0;

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

async function seedReports(count: number): Promise<void> {
  reportIds = [];
  for (let index = 0; index < count; index += 1) {
    reporterSeq += 1;
    const [row] = await getDb()
      .insert(reportsTable)
      .values({
        reportedType: 'post',
        reportedId: POST_ID,
        reporter: `${PREFIX}reporter-${reporterSeq}`,
        categories: ['spam'],
        crowdSourceCaseId: CASE_ID,
        localStatus: 'submitted',
      })
      .returning({ id: reportsTable.id });
    reportIds.push(row.id);
  }
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('decision worker', () => {
  beforeEach(async () => {
    await getDb().delete(reportsTable).where(like(reportsTable.reporter, `${PREFIX}%`));
    caseSeq += 1;
    CASE_ID = `case-test-decisionworker-${caseSeq}`;
    await seedReports(1);
    vi.clearAllMocks();
    applyDecisionEnforcement.mockResolvedValue([{ action: 'restrict', result: 'recorded' }]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await getDb().delete(reportsTable).where(like(reportsTable.reporter, `${PREFIX}%`));
  });

  it('writes the decision onto the report and records what Mention did', async () => {
    const decision = decisionFixture({ caseId: CASE_ID, outcome: 'violation' });

    await applyDecisionOutboxEvent(event(decision));

    const stored = await findReportById(reportIds[0]);
    expect(stored).toMatchObject({
      // A violation reached a conclusion Mention can act on.
      status: 'resolved',
      // A FINAL decision closes Mention's side of the case.
      localStatus: 'closed',
      decisionId: decision.id,
      decisionRevision: 1,
      decisionOutcome: 'violation',
      decisionStatus: 'final',
      enforcedAction: 'restrict',
    });
    expect(stored?.enforcedAt).toBeInstanceOf(Date);
    expect(stored?.decidedAt).toEqual(new Date(decision.publishedAt));
  });

  it('enforces once for a case however many reports opened it', async () => {
    await seedReports(5);
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
      subject: { type: 'post', id: POST_ID },
    });
    // Every report still learns the outcome.
    for (const id of reportIds) {
      expect((await findReportById(id))?.decisionOutcome).toBe('violation');
    }
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
    const stored = await findReportById(reportIds[0]);
    expect(stored?.localStatus).toBe('submitted');
    expect(stored?.decisionStatus).toBe('provisional');
  });

  it('refuses to overwrite a newer revision with an older one', async () => {
    await getDb()
      .update(reportsTable)
      .set({ decisionRevision: 3, decisionOutcome: 'no_violation' })
      .where(eq(reportsTable.id, reportIds[0]));

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
    const stored = await findReportById(reportIds[0]);
    expect(stored?.decisionRevision).toBe(3);
    expect(stored?.decisionOutcome).toBe('no_violation');
  });

  it('accepts the FIRST decision, which has no stored revision to compare against', async () => {
    // `NULL <= n` is NULL, which excludes the row — so the absent case has to be
    // spelled out in the predicate. Without it this sweep would silently refuse
    // every report's first decision, and the revision test above would still pass.
    // A revision after the first must name what it supersedes; the contract
    // refuses one that does not, so the fixture says so.
    const decision = decisionFixture({
      caseId: CASE_ID,
      outcome: 'violation',
      revision: 4,
      supersedesDecisionId: 'dec_earlier',
    });

    await applyDecisionOutboxEvent(event(decision));

    expect((await findReportById(reportIds[0]))?.decisionRevision).toBe(4);
  });

  it('defers when no local report is linked to the case yet', async () => {
    await getDb().delete(reportsTable).where(like(reportsTable.reporter, `${PREFIX}%`));
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
    const stored = await findReportById(reportIds[0]);
    expect(stored?.status).toBe('reviewed');
    expect(stored?.status).not.toBe('dismissed');
    expect(stored?.decisionOutcome).toBe('inconclusive');
  });
});
