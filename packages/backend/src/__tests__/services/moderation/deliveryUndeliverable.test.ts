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
    // Nothing about this process should look like a deployment unless a test
    // says so: the two env vars below are exactly what decides it.
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

  it('is absent where this process cannot prove it is Mention', async () => {
    const { getCrowdSourceClient } = await load();

    /**
     * `undefined`, not a throw. A local checkout runs this way, and a report
     * filed there must still be stored — the delivery worker is what notices
     * there is nowhere to send it.
     *
     * This replaced a `CROWDSOURCE_ENABLED` check, and it is a stronger
     * statement: a flag says what somebody typed, this says what the process
     * can actually do.
     */
    expect(getCrowdSourceClient()).toBeUndefined();
    // Cached, so the reason is logged once rather than once per delivery attempt
    // per report — which would bury the cause it exists to reveal.
    expect(getCrowdSourceClient()).toBeUndefined();
  });

  it('builds on a task role alone, with no key of any kind', async () => {
    // The whole point of the change: ECS sets this and nothing else does, so a
    // deployment carrying NO secret still authenticates.
    vi.stubEnv('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', '/v2/credentials/abc');
    const { getCrowdSourceClient } = await load();

    const client = getCrowdSourceClient();

    expect(client).toBeDefined();
    // Built once and kept for the process.
    expect(getCrowdSourceClient()).toBe(client);
  });

  it('builds on an Oxy service api key where there is no task role', async () => {
    vi.stubEnv('OXY_SERVICE_API_KEY', 'mention-service-key');
    vi.stubEnv('OXY_SERVICE_API_SECRET', 'mention-service-secret');
    const { getCrowdSourceClient } = await load();

    expect(getCrowdSourceClient()).toBeDefined();
  });

  it('presents an Oxy token and never a CrowdSource service key', async () => {
    vi.stubEnv('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', '/v2/credentials/abc');
    // A key in the environment must not change what is presented. Mention holds
    // no CrowdSource credential; if one ever appeared it would be a leftover,
    // and using it would silently move the tenant back to a secret somebody has
    // to rotate.
    vi.stubEnv('CROWDSOURCE_SERVICE_KEY', 'app_mention:csk_test:secret-value');
    const constructed: Array<Record<string, unknown>> = [];
    vi.doMock('@oxy.so/crowdsource', () => ({
      CrowdSource: class {
        applicationId = Promise.resolve('app_from_the_binding');
        constructor(options: Record<string, unknown>) {
          constructed.push(options);
        }
      },
    }));
    const { getCrowdSourceClient } = await load();

    getCrowdSourceClient();

    expect(constructed).toHaveLength(1);
    expect(typeof constructed[0]?.oxyToken).toBe('function');
    expect(constructed[0]).not.toHaveProperty('serviceKey');
    vi.doUnmock('@oxy.so/crowdsource');
  });

  it('holds reports until a decision could come back, and lets notes through anyway', async () => {
    vi.stubEnv('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', '/v2/credentials/abc');
    vi.stubEnv('CROWDSOURCE_WEBHOOK_SECRET', '');
    const withoutSecret = await load();

    /**
     * A report delivered with no way to verify the decision coming back is
     * worse than one held locally: the case is judged and the outcome arrives
     * at an endpoint that refuses it. Community notes have no webhook in the
     * path, so the client is still there for them.
     */
    expect(withoutSecret.canDeliverToCrowdSource()).toBe(false);
    expect(withoutSecret.getCrowdSourceClient()).toBeDefined();

    vi.stubEnv('CROWDSOURCE_WEBHOOK_SECRET', 'a-webhook-secret-16-chars');
    const withSecret = await load();

    expect(withSecret.canDeliverToCrowdSource()).toBe(true);
  });
});
