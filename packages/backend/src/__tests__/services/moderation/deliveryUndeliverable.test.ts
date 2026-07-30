import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The three ways a delivery ends without reaching CrowdSource.
 *
 * Each has a different correct answer, and getting them wrong is expensive in a way
 * that is invisible: a report retried for days because the content was deleted, a
 * report marked unsupported because the service was briefly down, or a report
 * silently dead-lettered because the integration was not switched on yet.
 */

type Doc = Record<string, unknown>;

let report: Doc | null;
let updates: Doc[];

vi.mock('../../../models/Report.model', async () => {
  const actual = await vi.importActual<typeof import('../../../models/Report.model')>(
    '../../../models/Report.model',
  );
  return {
    ...actual,
    default: {
      findById: vi.fn(() => ({ lean: async () => (report ? { ...report } : null) })),
      updateOne: vi.fn(async (_filter: Doc, update: Doc) => {
        updates.push((update.$set as Doc | undefined) ?? {});
        return { matchedCount: 1, modifiedCount: 1 };
      }),
    },
  };
});

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

import { ReportCategory, ReportedType } from '../../../models/Report.model';
import {
  CrowdSourceUnavailableError,
  ModerationDeliveryRejectedError,
  deliverReportOutboxEvent,
} from '../../../services/moderation/ModerationDeliveryWorker';
import { subjectProviderFor } from '../../../services/moderation/subjects/registry';
import type { ModerationOutboxEvent } from '../../../services/moderation/ModerationOutboxService';

const REPORT_ID = '507f1f77bcf86cd799439011';

function event(payload: Doc = { reportId: REPORT_ID }): ModerationOutboxEvent {
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

describe('delivery worker — the undeliverable cases', () => {
  beforeEach(() => {
    updates = [];
    report = {
      _id: new mongoose.Types.ObjectId(REPORT_ID),
      reportedType: ReportedType.POST,
      reportedId: '507f1f77bcf86cd799439022',
      reporter: 'oxy-user-reporter',
      categories: [ReportCategory.SPAM],
      createdAt: new Date('2026-07-28T18:00:00.000Z'),
    };
    vi.clearAllMocks();
    vi.mocked(subjectProviderFor).mockReturnValue({
      reportedType: 'post',
      subjectType: 'social.post',
      snapshot,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('closes a report whose content is gone instead of retrying for days', async () => {
    snapshot.mockResolvedValue(null);

    await deliverReportOutboxEvent(event());

    // Deletion between the report and its delivery is ordinary. There is nothing to
    // review, so the event completes and the report says why.
    expect(updates[0]).toMatchObject({
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
    await expect(deliverReportOutboxEvent(event())).rejects.toMatchObject({
      name: 'ModerationSubjectUnsupportedError',
      retryable: false,
    });
    expect(updates).toHaveLength(0);
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

    await expect(deliverReportOutboxEvent(event())).rejects.toBeInstanceOf(
      CrowdSourceUnavailableError,
    );
    await expect(deliverReportOutboxEvent(event())).rejects.toMatchObject({ retryable: true });
    // The report is untouched — nothing about it changed, only the world's readiness.
    expect(updates).toHaveLength(0);
  });

  it('completes an event whose report no longer exists', async () => {
    report = null;

    await expect(deliverReportOutboxEvent(event())).resolves.toBeUndefined();

    // Retrying would keep looking for a row that will never come back.
    expect(updates).toHaveLength(0);
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
