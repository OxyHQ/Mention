import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, like } from 'drizzle-orm';
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
 *
 * ## What the Postgres port changed
 *
 * The dedupe store and the outbox are REAL ROWS. That replaces the file's most
 * load-bearing fake: `ModerationEvent.create` had to RAISE a synthetic `E11000` to
 * express "somebody else has this event", because in Mongo that answer only ever
 * arrived as an error — so the fake decided, in the test, what the production code
 * was then judged on for classifying correctly. `moderation_events.id` is the
 * primary key and `claimModerationEvent` answers with a VALUE (`ON CONFLICT DO
 * NOTHING … RETURNING`), so the redelivery below is deduplicated by the database.
 *
 * ## The env is set before the imports, not around them
 *
 * `buildApp` used to `vi.resetModules()` per test so `config` would re-read the
 * stubbed secrets. It cannot now: `db/postgres` keeps its pool in a module-level
 * binding, so a reset registry hands the router a `getDb()` that throws — or, if
 * reconnected, a second pool per test against a shared `max_connections`. The
 * secrets are therefore stubbed in `vi.hoisted`, which runs before any import, and
 * the router is built once from the one config. The single test that needs NO
 * secret still resets the registry, and can: it returns an empty router without
 * ever touching the database.
 */

const WEBHOOK_SECRET = 'test-webhook-secret-at-least-16-chars';
const PREVIOUS_SECRET = 'previous-webhook-secret-16-chars';

/**
 * Namespaces every event id this file writes.
 *
 * `moderation_events.id` IS the webhook event id, and `moderation_outbox` rows for
 * a decision are `moderation:decision.apply:<event id>` — so one prefix scopes both
 * tables' cleanup and every count below. Ids stay inside the contract's
 * `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`, which the fixtures validate before returning.
 */
const EVENT_PREFIX = 'evt-webhook-suite-';

vi.hoisted(() => {
  vi.stubEnv('CROWDSOURCE_ENABLED', 'true');
  vi.stubEnv('CROWDSOURCE_SERVICE_KEY', 'app_mention:csk_test:secret-value');
  vi.stubEnv('CROWDSOURCE_WEBHOOK_SECRET', 'test-webhook-secret-at-least-16-chars');
  vi.stubEnv('CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS', 'previous-webhook-secret-16-chars');
});

/**
 * The one seam that has to fail on demand: "the work cannot be recorded".
 *
 * A pass-through wrapper rather than a stub — every other test runs the real
 * enqueue against real rows, and the armed failure throws INSIDE
 * `recordDecisionEvent`'s transaction, so the audit row's completion is rolled back
 * by Postgres exactly as a lost connection would roll it back.
 */
const mocks = vi.hoisted(() => ({ enqueueFailure: null as Error | null }));

vi.mock('../../../db/moderation/moderationOutboxRepository', async () => {
  const actual = await vi.importActual<
    typeof import('../../../db/moderation/moderationOutboxRepository')
  >('../../../db/moderation/moderationOutboxRepository');
  return {
    ...actual,
    enqueueModerationOutboxEvent: async (
      ...args: Parameters<typeof actual.enqueueModerationOutboxEvent>
    ) => {
      const failure = mocks.enqueueFailure;
      if (failure) {
        mocks.enqueueFailure = null;
        throw failure;
      }
      return actual.enqueueModerationOutboxEvent(...args);
    },
  };
});

import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { moderationEvents, moderationOutbox } from '../../../db/schema/moderation';
import { decisionApplyEventId } from '../../../services/moderation/ModerationOutboxService';
import { createCrowdSourceWebhookRoutes } from '../../../routes/crowdSourceWebhook.routes';

let app: express.Express;
let eventSeq = 0;

/** A namespaced, contract-valid webhook event id. */
function nextEventId(label: string): string {
  eventSeq += 1;
  return `${EVENT_PREFIX}${label}-${eventSeq}`;
}

/** How a delivery should differ from a correct one. */
type DeliveryOverrides = Partial<Omit<SignWebhookInput, 'event'>>;

async function deliver(
  target: express.Express,
  event: unknown,
  overrides: DeliveryOverrides = {},
): Promise<request.Response> {
  const delivery = signWebhookDelivery({ secret: WEBHOOK_SECRET, event, ...overrides });
  return await request(target)
    .post('/webhooks/crowdsource')
    .set(delivery.headers)
    .send(delivery.body);
}

/** Every audit row this file wrote. */
async function eventRows() {
  return getDb()
    .select()
    .from(moderationEvents)
    .where(like(moderationEvents.id, `${EVENT_PREFIX}%`));
}

/** Every unit of work this file's deliveries queued. */
async function outboxRows() {
  return getDb()
    .select()
    .from(moderationOutbox)
    .where(like(moderationOutbox.id, `${decisionApplyEventId(EVENT_PREFIX)}%`));
}

beforeAll(async () => {
  await connectPostgres();
  app = express();
  app.use('/webhooks', createCrowdSourceWebhookRoutes());
  /**
   * Mounted AFTER the webhook, mirroring `app.ts`. Present rather than omitted
   * because its absence would make this test pass for the wrong reason — the whole
   * hazard is a parser that runs first.
   */
  app.use(express.json());
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await closePostgres();
});

describe('CrowdSource webhook receiver', () => {
  beforeEach(async () => {
    await getDb()
      .delete(moderationOutbox)
      .where(like(moderationOutbox.id, `${decisionApplyEventId(EVENT_PREFIX)}%`));
    await getDb().delete(moderationEvents).where(like(moderationEvents.id, `${EVENT_PREFIX}%`));
    mocks.enqueueFailure = null;
    // Re-established per test rather than once, so the pass-through case below can
    // clear them without leaving every later test dependent on its ordering.
    vi.stubEnv('CROWDSOURCE_WEBHOOK_SECRET', WEBHOOK_SECRET);
    vi.stubEnv('CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS', PREVIOUS_SECRET);
  });

  afterEach(async () => {
    await getDb()
      .delete(moderationOutbox)
      .where(like(moderationOutbox.id, `${decisionApplyEventId(EVENT_PREFIX)}%`));
    await getDb().delete(moderationEvents).where(like(moderationEvents.id, `${EVENT_PREFIX}%`));
  });

  it('accepts a signed decision once and queues exactly one unit of work', async () => {
    const id = nextEventId('redelivery');
    const event = caseDecidedEventFixture({ id });

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
     * even before `moderation_enforcements`' unique index is consulted. Two rows here
     * would mean two attempts at the same enforcement, which only the index would
     * then catch.
     */
    expect(await outboxRows()).toEqual([
      expect.objectContaining({ id: decisionApplyEventId(id), kind: 'decision.apply' }),
    ]);
    expect(await eventRows()).toEqual([expect.objectContaining({ id, state: 'queued' })]);
  });

  it('records the decision payload whole, so a newer field is not silently dropped', async () => {
    const id = nextEventId('payload');
    const event = caseDecidedEventFixture({ id });

    await deliver(app, event);

    // §10.11 makes the payload loose; the audit row keeps what arrived.
    const [row] = await eventRows();
    expect(row.payload).toMatchObject({
      caseId: event.data.caseId,
      decision: expect.objectContaining({ id: expect.any(String), revision: 1 }),
    });
    // And the case id is a COLUMN too, not only a key inside the blob — that is what
    // `moderation_events_case_id_idx` is for when a report looks stuck.
    expect(row.caseId).toBe(event.data.caseId);
  });

  it('refuses a body that does not match its signature', async () => {
    const event = caseDecidedEventFixture({ id: nextEventId('tampered') });

    const response = await deliver(app, event, {
      tamperedBody: JSON.stringify({ ...event, data: { caseId: 'case-attacker' } }),
    });

    /**
     * The REASON, not just the status.
     *
     * `WEBHOOK_REJECTIONS` in `@oxyhq/crowdsource-express` holds eleven tokens and
     * every one of them answers 401, so `toBe(401)` alone is satisfied by a
     * `missing_event_id` just as well as by a signature that failed to verify —
     * which means it survives deleting the signature comparison entirely. Naming
     * the token is what makes this a test of the signature check.
     *
     * The values are read off `verify.ts`, never guessed: a tampered body and a
     * forged secret both reach the HMAC comparison and come back
     * `signature_mismatch`, while a stale delivery is refused earlier, at the
     * window check, as `timestamp_out_of_window`.
     */
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ received: false, rejection: 'signature_mismatch' });
    // Nothing was claimed, so the real delivery can still arrive and be processed.
    expect(await eventRows()).toHaveLength(0);
    expect(await outboxRows()).toHaveLength(0);
  });

  it('refuses a delivery signed with the wrong secret', async () => {
    const response = await deliver(app, caseDecidedEventFixture({ id: nextEventId('forged') }), {
      secret: 'a-secret-nobody-configured-here',
    });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ received: false, rejection: 'signature_mismatch' });
    expect(await outboxRows()).toHaveLength(0);
  });

  it('refuses a delivery outside the five-minute window', async () => {
    const response = await deliver(app, caseDecidedEventFixture({ id: nextEventId('stale') }), {
      timestampSeconds: Math.floor(Date.now() / 1_000) - 3_600,
    });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      received: false,
      rejection: 'timestamp_out_of_window',
    });
    expect(await outboxRows()).toHaveLength(0);
  });

  it('accepts the previous secret during a rotation', async () => {
    const response = await deliver(app, caseDecidedEventFixture({ id: nextEventId('rotated') }), {
      secret: PREVIOUS_SECRET,
    });

    // §10.8 allows two valid secrets so a rotation drops nothing.
    expect(response.status).toBe(200);
    expect(await outboxRows()).toHaveLength(1);
  });

  it('hands the SDK the secrets Mention resolved, instead of leaving it to read the environment', async () => {
    /**
     * What every other test in this file CANNOT see.
     *
     * `configuredSecrets` in `@oxyhq/crowdsource-express` is
     * `options.secret ?? process.env[WEBHOOK_SECRET_ENV_VAR]`, and every test here
     * runs with that variable set. So deleting the `secret` / `previousSecret`
     * pass-through in `crowdSourceWebhook.routes.ts` leaves all of them green — the
     * SDK's own env fallback quietly covers for it. They confirm signatures are
     * verified; none of them confirms MENTION is why.
     *
     * The discriminator is an ordering asymmetry, checked rather than assumed:
     * `config/index.ts` builds `environment` from ONE
     * `parseRuntimeEnvironment(process.env)` at module load, so the router captured
     * both secrets when this file imported it, whereas the SDK re-reads
     * `process.env` on every request. Clearing the variables here therefore leaves
     * standing only a value Mention captured and passed explicitly. With the
     * pass-through gone the SDK sees no secret at all and refuses with
     * `no_secret_configured`.
     *
     * Not tidiness: `config` is where the secret is length-validated
     * (`optionalString(16)`), so a deployment leaning on the SDK's raw env read
     * would silently accept a secret this app rejects at boot.
     */
    vi.stubEnv('CROWDSOURCE_WEBHOOK_SECRET', undefined);
    vi.stubEnv('CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS', undefined);

    const active = await deliver(app, caseDecidedEventFixture({ id: nextEventId('passthrough') }));
    expect(active.status).toBe(200);
    expect(await outboxRows()).toHaveLength(1);

    // Asserted separately because the two are passed separately: a rotation that
    // only forwards the active secret drops every delivery still signed with the
    // old one, and that is exactly the loss §10.8's overlap exists to prevent.
    const previous = await deliver(
      app,
      caseDecidedEventFixture({ id: nextEventId('passthrough') }),
      { secret: PREVIOUS_SECRET },
    );
    expect(previous.status).toBe(200);
    expect(await outboxRows()).toHaveLength(2);
  });

  it('acknowledges an event type it does not handle without queueing work', async () => {
    const id = nextEventId('future');
    const event = {
      id,
      type: 'case.something_new',
      createdAt: '2026-07-29T12:00:00.000Z',
      organizationId: 'org_test',
      applicationId: 'app_test',
      data: { caseId: 'case-test-webhook-unhandled' },
    };

    const response = await deliver(app, event);

    // §10.11: a newer CrowdSource never breaks an older receiver.
    expect(response.status).toBe(200);
    expect(await outboxRows()).toHaveLength(0);
    // Recorded anyway — "did CrowdSource tell us about this case" has to be answerable.
    expect(await eventRows()).toEqual([
      expect.objectContaining({
        id,
        state: 'ignored',
        type: 'case.something_new',
        caseId: 'case-test-webhook-unhandled',
      }),
    ]);
  });

  it('releases the claim when the work cannot be recorded, so a retry still lands', async () => {
    const id = nextEventId('released');
    const event = caseDecidedEventFixture({ id });
    mocks.enqueueFailure = new Error('the outbox write did not land');

    const failed = await deliver(app, event);

    // Never a 2xx: a 2xx retires the delivery as processed and the decision is gone.
    expect(failed.status).toBeGreaterThanOrEqual(500);
    /**
     * The claim row is GONE, not merely left un-queued. The middleware inserted it
     * before running the handler, so a failure that did not release it would
     * deduplicate every redelivery of a decision nobody ever recorded — and the
     * audit row would say the event arrived.
     */
    expect(await eventRows()).toHaveLength(0);
    expect(await outboxRows()).toHaveLength(0);

    const retry = await deliver(app, event);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ duplicate: false });
    expect(await outboxRows()).toEqual([
      expect.objectContaining({ id: decisionApplyEventId(id), kind: 'decision.apply' }),
    ]);
  });
});

describe('CrowdSource webhook receiver — unconfigured', () => {
  it('is not mounted at all without a configured secret', async () => {
    /**
     * The one case that needs a DIFFERENT `config`, so it is the one case that
     * resets the module registry — safe here precisely because an unmounted router
     * touches no database: it reads one string and returns.
     */
    vi.resetModules();
    vi.stubEnv('CROWDSOURCE_ENABLED', 'false');
    vi.stubEnv('CROWDSOURCE_WEBHOOK_SECRET', '');
    vi.stubEnv('CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS', '');
    const routes = await import('../../../routes/crowdSourceWebhook.routes');

    const unconfigured = express();
    unconfigured.use('/webhooks', routes.createCrowdSourceWebhookRoutes());

    const response = await request(unconfigured).post('/webhooks/crowdsource').send({});

    /**
     * 404, not a permissive 200. A route that answers without a secret is a route
     * somebody will later reason about as if it had verified something.
     */
    expect(response.status).toBe(404);
    // And nothing was recorded on the way to saying no.
    expect(
      await getDb()
        .select()
        .from(moderationEvents)
        .where(eq(moderationEvents.id, `${EVENT_PREFIX}unconfigured`)),
    ).toHaveLength(0);
  });
});
