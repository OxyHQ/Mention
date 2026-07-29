import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  caseDecidedEventFixture,
  signWebhookDelivery,
  type SignWebhookInput,
} from '@oxyhq/crowdsource-testing';

/**
 * The webhook receiver, against genuinely signed deliveries.
 *
 * The signing here is the simulator's, which shares `buildWebhookSignedPayload` with
 * the verifier and with the service — so a delivery that passes below is a delivery
 * CrowdSource can actually produce. That matters more than it sounds: a receiver
 * verified against a signature the test computed its own way proves the test and the
 * receiver agree, and both can be wrong together.
 *
 * Half of these cases assert a REFUSAL. A suite that only ever sends valid
 * deliveries proves a receiver can say yes.
 */

const WEBHOOK_SECRET = 'test-webhook-secret-at-least-16-chars';
const PREVIOUS_SECRET = 'previous-webhook-secret-16-chars';

type Doc = Record<string, unknown>;

/** Events, deduplicated on `_id` exactly as the unique index does. */
const events: Doc[] = [];
/** Outbox rows the inbound service creates. */
const outbox: Doc[] = [];

vi.mock('../../../models/ModerationEvent', () => ({
  MODERATION_EVENT_RETENTION_SECONDS: 90 * 24 * 60 * 60,
  default: {
    create: vi.fn(async (doc: Doc) => {
      if (events.some((existing) => existing._id === doc._id)) {
        const error = new Error(`E11000 duplicate key error: ${String(doc._id)}`);
        Object.assign(error, { code: 11000 });
        throw error;
      }
      events.push({ ...doc });
      return doc;
    }),
    updateOne: vi.fn(async (filter: Doc, update: Doc) => {
      const target = events.find((doc) => doc._id === filter._id);
      if (target) Object.assign(target, (update.$set as Doc | undefined) ?? {});
      return { matchedCount: target ? 1 : 0, modifiedCount: target ? 1 : 0 };
    }),
    deleteOne: vi.fn(async (filter: Doc) => {
      const index = events.findIndex((doc) => doc._id === filter._id);
      if (index >= 0) events.splice(index, 1);
      return { deletedCount: index >= 0 ? 1 : 0 };
    }),
  },
}));

vi.mock('../../../models/ModerationOutbox', () => ({
  MODERATION_OUTBOX_RETENTION_SECONDS: 90 * 24 * 60 * 60,
  default: {
    updateOne: vi.fn(async (filter: Doc, update: Doc) => {
      const id = filter._id;
      if (!outbox.some((doc) => doc._id === id)) {
        outbox.push({ ...((update.$setOnInsert as Doc | undefined) ?? {}) });
      }
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 1 };
    }),
  },
}));

async function buildApp(): Promise<express.Express> {
  vi.resetModules();
  vi.stubEnv('CROWDSOURCE_ENABLED', 'true');
  vi.stubEnv('CROWDSOURCE_SERVICE_KEY', 'app_mention:csk_test:secret-value');
  vi.stubEnv('CROWDSOURCE_WEBHOOK_SECRET', WEBHOOK_SECRET);
  vi.stubEnv('CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS', PREVIOUS_SECRET);

  const { createCrowdSourceWebhookRoutes } = await import(
    '../../../routes/crowdSourceWebhook.routes'
  );

  const app = express();
  app.use('/webhooks', createCrowdSourceWebhookRoutes());
  /**
   * Mounted AFTER the webhook, mirroring `app.ts`. Present rather than omitted
   * because its absence would make this test pass for the wrong reason — the whole
   * hazard is a parser that runs first.
   */
  app.use(express.json());
  return app;
}

/** How a delivery should differ from a correct one. */
type DeliveryOverrides = Partial<Omit<SignWebhookInput, 'event'>>;

async function deliver(
  app: express.Express,
  event: unknown,
  overrides: DeliveryOverrides = {},
): Promise<request.Response> {
  const delivery = signWebhookDelivery({ secret: WEBHOOK_SECRET, event, ...overrides });
  return await request(app)
    .post('/webhooks/crowdsource')
    .set(delivery.headers)
    .send(delivery.body);
}

describe('CrowdSource webhook receiver', () => {
  beforeEach(() => {
    events.length = 0;
    outbox.length = 0;
    vi.clearAllMocks();
    // The inbound service commits the audit row and the outbox row together.
    vi.spyOn(mongoose, 'startSession').mockResolvedValue({
      withTransaction: vi.fn(async (operation: () => Promise<void>) => {
        await operation();
      }),
      endSession: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('accepts a signed decision once and queues exactly one unit of work', async () => {
    const app = await buildApp();
    const event = caseDecidedEventFixture({ id: 'evt_redelivery_1' });

    const first = await deliver(app, event);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ received: true, duplicate: false });

    // The redelivery §10.9 guarantees will happen, byte-identical.
    const second = await deliver(app, event);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ received: true, duplicate: true });

    /**
     * The dedupe is what makes enforcement safe at the door as well as at the
     * database: one durable unit of work exists, so the decision worker runs once
     * even before `ModerationEnforcement`'s unique index is consulted. Two rows here
     * would mean two attempts at the same enforcement, which only the index would
     * then catch.
     */
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ kind: 'decision.apply' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ _id: 'evt_redelivery_1', state: 'queued' });
  });

  it('records the decision payload whole, so a newer field is not silently dropped', async () => {
    const app = await buildApp();
    const event = caseDecidedEventFixture({ id: 'evt_payload_1' });

    await deliver(app, event);

    // §10.11 makes the payload loose; the audit row keeps what arrived.
    expect(events[0].payload).toMatchObject({
      caseId: event.data.caseId,
      decision: expect.objectContaining({ id: expect.any(String), revision: 1 }),
    });
  });

  it('refuses a body that does not match its signature', async () => {
    const app = await buildApp();
    const event = caseDecidedEventFixture({ id: 'evt_tampered_1' });

    const response = await deliver(app, event, {
      tamperedBody: JSON.stringify({ ...event, data: { caseId: 'case_attacker' } }),
    });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ received: false });
    // Nothing was claimed, so the real delivery can still arrive and be processed.
    expect(events).toHaveLength(0);
    expect(outbox).toHaveLength(0);
  });

  it('refuses a delivery signed with the wrong secret', async () => {
    const app = await buildApp();
    const response = await deliver(app, caseDecidedEventFixture({ id: 'evt_forged_1' }), {
      secret: 'a-secret-nobody-configured-here',
    });

    expect(response.status).toBe(401);
    expect(outbox).toHaveLength(0);
  });

  it('refuses a delivery outside the five-minute window', async () => {
    const app = await buildApp();
    const response = await deliver(app, caseDecidedEventFixture({ id: 'evt_stale_1' }), {
      timestampSeconds: Math.floor(Date.now() / 1_000) - 3_600,
    });

    expect(response.status).toBe(401);
    expect(outbox).toHaveLength(0);
  });

  it('accepts the previous secret during a rotation', async () => {
    const app = await buildApp();
    const response = await deliver(app, caseDecidedEventFixture({ id: 'evt_rotated_1' }), {
      secret: PREVIOUS_SECRET,
    });

    // §10.8 allows two valid secrets so a rotation drops nothing.
    expect(response.status).toBe(200);
    expect(outbox).toHaveLength(1);
  });

  it('acknowledges an event type it does not handle without queueing work', async () => {
    const app = await buildApp();
    const event = {
      id: 'evt_future_1',
      type: 'case.something_new',
      createdAt: '2026-07-29T12:00:00.000Z',
      organizationId: 'org_test',
      applicationId: 'app_test',
      data: { caseId: 'case_test_1' },
    };

    const response = await deliver(app, event);

    // §10.11: a newer CrowdSource never breaks an older receiver.
    expect(response.status).toBe(200);
    expect(outbox).toHaveLength(0);
    // Recorded anyway — "did CrowdSource tell us about this case" has to be answerable.
    expect(events[0]).toMatchObject({ _id: 'evt_future_1', state: 'ignored' });
  });

  it('releases the claim when the work cannot be recorded, so a retry still lands', async () => {
    const app = await buildApp();
    const ModerationOutbox = (await import('../../../models/ModerationOutbox')).default;
    vi.mocked(ModerationOutbox.updateOne).mockRejectedValueOnce(new Error('mongo unavailable'));

    const event = caseDecidedEventFixture({ id: 'evt_released_1' });
    const failed = await deliver(app, event);

    // Never a 2xx: a 2xx retires the delivery as processed and the decision is gone.
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(events).toHaveLength(0);

    const retry = await deliver(app, event);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ duplicate: false });
    expect(outbox).toHaveLength(1);
  });

  it('is not mounted at all without a configured secret', async () => {
    vi.resetModules();
    vi.stubEnv('CROWDSOURCE_ENABLED', 'false');
    vi.stubEnv('CROWDSOURCE_WEBHOOK_SECRET', '');
    const { createCrowdSourceWebhookRoutes } = await import(
      '../../../routes/crowdSourceWebhook.routes'
    );

    const app = express();
    app.use('/webhooks', createCrowdSourceWebhookRoutes());

    const response = await request(app).post('/webhooks/crowdsource').send({});

    /**
     * 404, not a permissive 200. A route that answers without a secret is a route
     * somebody will later reason about as if it had verified something.
     */
    expect(response.status).toBe(404);
  });
});
