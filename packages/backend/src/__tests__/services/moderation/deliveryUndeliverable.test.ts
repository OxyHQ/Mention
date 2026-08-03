import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { like } from 'drizzle-orm';

/**
 * The three ways a delivery ends without reaching CrowdSource.
 *
 * Each has a different correct answer, and getting them wrong is expensive in a way
 * that is invisible: a report retried for days because the content was deleted, a
 * report marked unsupported because the service was briefly down, or a report
 * silently dead-lettered because the integration was not switched on yet.
 *
 * ## What the Postgres port changed
 *
 * The report is a REAL ROW, and the assertions are on what it now holds rather
 * than on the `$set` document a mocked `updateOne` was handed. Those are
 * different claims: the old one could not see a write that named a path the
 * schema does not have, and — more to the point here — "the report is untouched"
 * was `updates.length === 0`, which is a statement about calls. It is now a
 * comparison against the row as it was before the delivery ran, so a write that
 * lands the same values is no longer indistinguishable from no write at all.
 *
 * The subject registry and the CrowdSource client stay mocked: one is the seam
 * this file drives directly, the other is a network client.
 */

type Doc = Record<string, unknown>;

const snapshot = vi.fn();

vi.mock('../../../services/moderation/subjects/registry', async () => {
  const actual = await vi.importActual<
    typeof import('../../../services/moderation/subjects/registry')
  >('../../../services/moderation/subjects/registry');
  return { ...actual, subjectProviderFor: vi.fn() };
});

const reportsCreate = vi.fn();

vi.mock('../../../services/moderation/crowdSourceClient', () => ({
  getCrowdSourceClient: vi.fn(() => ({ reports: { create: reportsCreate } })),
  resetCrowdSourceClient: vi.fn(),
}));

import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { reports } from '../../../db/schema/moderation';
import { findReportById } from '../../../db/moderation/reportRepository';
import {
  CrowdSourceUnavailableError,
  ModerationDeliveryRejectedError,
  deliverReportOutboxEvent,
} from '../../../services/moderation/ModerationDeliveryWorker';
import { subjectProviderFor } from '../../../services/moderation/subjects/registry';
import type { ModerationOutboxEvent } from '../../../db/moderation/moderationOutboxRepository';

/** Namespaces every row this file writes, so a parallel file cannot collide. */
const PREFIX = 'moderation:test-delivery-undeliverable:';

/** An id that names no row — a uuid v7 shape nothing here mints. */
const MISSING_REPORT_ID = '01920000-0000-7000-8000-000000000000';

let reportId: string;

function event(payload: Doc): ModerationOutboxEvent {
  return {
    _id: 'moderation:report.submit:x',
    kind: 'report.submit',
    payload,
    attempts: 1,
    availableAt: new Date(),
    expiresAt: new Date(),
    createdAt: new Date(),
  } as ModerationOutboxEvent;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('delivery worker — the undeliverable cases', () => {
  beforeEach(async () => {
    await getDb().delete(reports).where(like(reports.reporter, `${PREFIX}%`));
    const [row] = await getDb()
      .insert(reports)
      .values({
        reportedType: 'post',
        reportedId: `${PREFIX}subject`,
        reporter: `${PREFIX}reporter`,
        categories: ['spam'],
        localStatus: 'queued',
      })
      .returning({ id: reports.id });
    reportId = row.id;
    vi.clearAllMocks();
    vi.mocked(subjectProviderFor).mockReturnValue({
      reportedType: 'post',
      subjectType: 'social.post',
      snapshot,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await getDb().delete(reports).where(like(reports.reporter, `${PREFIX}%`));
  });

  it('closes a report whose content is gone instead of retrying for days', async () => {
    snapshot.mockResolvedValue(null);

    await deliverReportOutboxEvent(event({ reportId }));

    // Deletion between the report and its delivery is ordinary. There is nothing to
    // review, so the event completes and the report says why.
    expect(await findReportById(reportId)).toMatchObject({
      localStatus: 'closed',
      localStatusReason: expect.stringContaining('no longer exists'),
    });
    expect(reportsCreate).not.toHaveBeenCalled();
  });

  it('dead-letters a report whose type has no provider, without touching the report', async () => {
    vi.mocked(subjectProviderFor).mockReturnValue(undefined);

    /**
     * Unreachable by design: intake never creates a delivery event for a type with no
     * provider, so an event that gets here came from something that bypassed
     * `ReportIntakeService`. That makes it a defect, not a state. `retryable: false`
     * sends it to the outbox's dead-letter, which the reconciliation sweep counts and a
     * human reads.
     *
     * Writing a local state instead would be worse than in the obvious way: it would
     * file a genuine defect at `received`, indistinguishable from the deliberate
     * local-only reports, where nothing alerts on it.
     */
    const before = await findReportById(reportId);
    await expect(deliverReportOutboxEvent(event({ reportId }))).rejects.toMatchObject({
      name: 'ModerationSubjectUnsupportedError',
      retryable: false,
    });
    expect(await findReportById(reportId)).toEqual(before);
  });

  it('defers, retryably, when the integration is not configured', async () => {
    snapshot.mockResolvedValue({
      subject: { externalId: 'p1', type: 'social.post' },
      content: 'text',
    });
    const { getCrowdSourceClient } = await import(
      '../../../services/moderation/crowdSourceClient'
    );
    vi.mocked(getCrowdSourceClient).mockReturnValue(undefined);

    const before = await findReportById(reportId);
    await expect(deliverReportOutboxEvent(event({ reportId }))).rejects.toBeInstanceOf(
      CrowdSourceUnavailableError,
    );
    await expect(deliverReportOutboxEvent(event({ reportId }))).rejects.toMatchObject({
      retryable: true,
    });
    // The report is untouched — nothing about it changed, only the world's readiness.
    expect(await findReportById(reportId)).toEqual(before);
  });

  it('completes an event whose report no longer exists', async () => {
    await expect(
      deliverReportOutboxEvent(event({ reportId: MISSING_REPORT_ID })),
    ).resolves.toBeUndefined();

    // Retrying would keep looking for a row that will never come back — and the
    // report this file DID seed must not have been touched instead.
    expect((await findReportById(reportId))?.localStatus).toBe('queued');
  });

  it('dead-letters an event with no report id', async () => {
    await expect(deliverReportOutboxEvent(event({}))).rejects.toBeInstanceOf(
      ModerationDeliveryRejectedError,
    );
    await expect(deliverReportOutboxEvent(event({}))).rejects.toMatchObject({
      retryable: false,
    });
  });
});

describe('CrowdSource client wrapper', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('is absent when the integration is switched off', async () => {
    vi.stubEnv('CROWDSOURCE_ENABLED', 'false');
    vi.doUnmock('../../../services/moderation/crowdSourceClient');
    const { getCrowdSourceClient } = await import(
      '../../../services/moderation/crowdSourceClient'
    );

    /**
     * `undefined`, not a throw. A local checkout and every deployment before rollout run
     * this way, and a report filed there must still be stored — the delivery worker is
     * what notices there is nowhere to send it.
     */
    expect(getCrowdSourceClient()).toBeUndefined();
  });

  it('reads its own applicationId off the service key', async () => {
    vi.stubEnv('CROWDSOURCE_ENABLED', 'true');
    vi.stubEnv('CROWDSOURCE_SERVICE_KEY', 'app_mention:csk_test:secret-value');
    vi.stubEnv('CROWDSOURCE_WEBHOOK_SECRET', 'a-webhook-secret-16-chars');
    vi.doUnmock('../../../services/moderation/crowdSourceClient');
    const { getCrowdSourceClient, resetCrowdSourceClient } = await import(
      '../../../services/moderation/crowdSourceClient'
    );
    resetCrowdSourceClient();

    const client = getCrowdSourceClient();

    // There is no applicationId option anywhere; it comes from the credential.
    expect(client?.applicationId).toBe('app_mention');
    // Built once and kept for the process.
    expect(getCrowdSourceClient()).toBe(client);
  });

  it('stays absent when the service key is malformed', async () => {
    vi.stubEnv('CROWDSOURCE_ENABLED', 'true');
    vi.stubEnv('CROWDSOURCE_SERVICE_KEY', 'this-is-not-three-parts');
    vi.stubEnv('CROWDSOURCE_WEBHOOK_SECRET', 'a-webhook-secret-16-chars');
    vi.doUnmock('../../../services/moderation/crowdSourceClient');
    const { getCrowdSourceClient, resetCrowdSourceClient } = await import(
      '../../../services/moderation/crowdSourceClient'
    );
    resetCrowdSourceClient();

    expect(getCrowdSourceClient()).toBeUndefined();
    // Cached as failed, so the error is logged once rather than once per delivery
    // attempt per report — which would bury the cause it exists to reveal.
    expect(getCrowdSourceClient()).toBeUndefined();
  });
});
