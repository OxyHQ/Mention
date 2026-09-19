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

describe('what is left of the CrowdSource client wrapper', () => {
  /**
   * Most of what this block used to assert now belongs to
   * `@crowdsource.you/core`: that the client is built once, that it presents an
   * Oxy service token and never a CrowdSource key, that it is absent where the
   * process can prove nothing, and that the tenant is resolved at boot. Those
   * tests moved with the code — three applications were each asserting them
   * against their own copy.
   *
   * What stays here is the one decision that is Mention's: a report must not
   * LEAVE a deployment that could not verify the decision coming back, while
   * community notes — a request and its answer, no webhook in the path — go out
   * as soon as there is a client.
   */
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // Nothing here should look like a deployment unless a test says so.
    vi.stubEnv('OXY_SERVICE_API_KEY', '');
    vi.stubEnv('OXY_SERVICE_API_SECRET', '');
    vi.stubEnv('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function load() {
    // Per call, not per test: `config` reads the environment once at import, so
    // a second load inside one test must get a fresh module graph or it reads
    // the first load's environment.
    vi.resetModules();
    vi.doUnmock('../../../services/moderation/crowdSourceClient');
    const module = await import('../../../services/moderation/crowdSourceClient');
    module.resetCrowdSourceClient();
    return module;
  }

  it('has no client where this process can prove nothing', async () => {
    const { getCrowdSourceClient, canDeliverToCrowdSource } = await load();

    // The library decides this; Mention only has to pass it on faithfully, and
    // a deployment that cannot authenticate must not be treated as able to
    // deliver.
    expect(getCrowdSourceClient()).toBeUndefined();
    expect(canDeliverToCrowdSource()).toBe(false);
  });

  it('holds reports until a decision could come back, and lets notes through anyway', async () => {
    vi.stubEnv('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', '/v2/credentials/abc');
    vi.stubEnv('CROWDSOURCE_WEBHOOK_SECRET', '');
    const withoutSecret = await load();

    expect(withoutSecret.canDeliverToCrowdSource()).toBe(false);
    expect(withoutSecret.getCrowdSourceClient()).toBeDefined();

    vi.stubEnv('CROWDSOURCE_WEBHOOK_SECRET', 'a-webhook-secret-16-chars');
    const withSecret = await load();

    expect(withSecret.canDeliverToCrowdSource()).toBe(true);
  });
});
