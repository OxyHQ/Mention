/**
 * The engagement outbox — durable domain events emitted by engagement commands,
 * and the bounded at-least-once dispatcher that drains them.
 *
 * ## The row IS the job
 *
 * `enqueueEngagementOutboxEvent` is the ONLY writer of this table, and it
 * requires a `Transaction`: the event and the relationship it describes commit
 * together or neither does. The type makes that mandatory rather than
 * conventional — `Database` is not assignable to `Transaction` (it has no
 * `rollback`), so a caller cannot pass the pool handle by accident.
 *
 * ## A replay writes NOTHING, and that is the point of the id
 *
 * `id` is derived from the relationship transition (`kind:relationshipId:vN`),
 * not from the HTTP request, so a transaction retry and two concurrent duplicate
 * requests upsert the SAME row. The insert is `ON CONFLICT DO NOTHING`, which
 * means a replay touches no column at all — not even `updated_at`. That matters
 * beyond tidiness: the dispatcher holds uncommitted writes on these rows while
 * claiming and renewing leases, so a replay that was a real write would block on
 * (and could deadlock with) a live claim.
 *
 * The Mongoose version had to fight its own `timestamps: true` to get here — it
 * named `createdAt`/`updatedAt` explicitly inside `$setOnInsert` AND passed
 * `timestamps: false`, because otherwise Mongo saw one path under two operators
 * and refused the whole update, aborting every like, downvote, save and unsave.
 * None of that survives the port: Postgres has no such conflict, and
 * `ON CONFLICT DO NOTHING` is a genuine no-op by construction.
 *
 * ## Claims are leases, so every consumer must be idempotent on `id`
 *
 * A claim sets `lease_owner` + `lease_until`; an EXPIRED lease is reclaimable, so
 * a worker that dies mid-delivery cannot strand its event — and a downstream
 * effect can therefore be applied twice. Handlers deduplicate on `event.id`.
 *
 * ## Retention deletes UNPROCESSED work
 *
 * `expires_at` is a hard ceiling (`ENGAGEMENT_OUTBOX_RETENTION_SECONDS`) and the
 * sweep in `db/expiry.ts` deletes by that deadline ALONE, not by status. A
 * `pending` event whose dispatcher stalled for the whole window is destroyed
 * rather than retried, so the like/save never reaches MTN, federation or
 * notifications. That is deliberate — an unbounded outbox is the worse failure —
 * but it is only safe if operational alerting fires long before the deadline.
 * There is no such alert today; see the module docblock in `db/expiry.ts`.
 */

import { randomUUID } from 'crypto';
import { and, asc, eq, gt, inArray, lt, lte, ne, or, sql } from 'drizzle-orm';
import { getDb, type Transaction } from '../db/postgres';
import type { SelectedRow } from '../db/schema/columns';
import {
  ENGAGEMENT_OUTBOX_RETENTION_SECONDS,
  engagementOutbox,
} from '../db/schema/outbox';
import { logger } from '../utils/logger';

const DEFAULT_LEASE_MS = 30_000;
const MIN_LEASE_MS = 1_000;
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const ORDERING_DEFERRAL_MS = 1_000;
const MIN_LEASE_RENEW_INTERVAL_MS = 250;
/** `last_error` is a diagnostic, not a payload; a hostile message cannot grow the row. */
const MAX_LAST_ERROR_LENGTH = 2_000;

/**
 * Derived from the column rather than restated, so the literal union and the
 * CHECK constraint cannot drift apart.
 */
export type EngagementOutboxKind = (typeof engagementOutbox.$inferSelect)['kind'];

/**
 * The vote value carried across a transition. `null` is a real value here — it
 * is what `post.unlike` records as the NEW value and what a first vote records
 * as the previous one — so it is distinct from the field being absent.
 */
export type EngagementVoteValue = 1 | -1;

/**
 * What a consumer needs to carry out one engagement transition.
 *
 * Mongo declared this as a nested subdocument with eight named leaves; the
 * leaves are real columns now (`payload_*`), and this is the shape they are read
 * back into. `postAuthorship` is NOT among them: Mongo carried a `Mixed`
 * snapshot of the post's authorship so the consumer would not have to re-read a
 * post that may have changed, but it is reconstructible from `post_authorships`,
 * so the consumer reads those rows instead. The consequence is a real (and
 * intended) semantic change — the notification fan-out now uses the authorship
 * as it stands at DELIVERY time, not as it stood at emit time.
 */
export interface EngagementOutboxPayload {
  actorOxyUserId: string;
  postId: string;
  relationshipId: string;
  postOwnerOxyUserId?: string;
  federationActivityId?: string;
  previousValue?: EngagementVoteValue | null;
  value?: EngagementVoteValue | null;
}

export interface EngagementOutboxEvent {
  id: string;
  kind: EngagementOutboxKind;
  revision: number;
  payload: EngagementOutboxPayload;
  attempts: number;
  availableAt: Date;
  leaseOwner?: string;
  leaseUntil?: Date;
  expiresAt: Date;
  createdAt: Date;
}

export interface EnqueueEngagementEventInput {
  kind: EngagementOutboxKind;
  relationshipId: string;
  revision: number;
  payload: EngagementOutboxPayload;
}

/**
 * Every column a dispatcher reads. Named explicitly rather than selecting the
 * whole row: `db.select().from(t)` returns EVERY column, which is how a naive
 * port starts shipping fields nobody meant to expose (`db/schema/protectedColumns.ts`).
 */
const EVENT_COLUMNS = {
  id: engagementOutbox.id,
  kind: engagementOutbox.kind,
  revision: engagementOutbox.revision,
  payloadActorOxyUserId: engagementOutbox.payloadActorOxyUserId,
  payloadPostId: engagementOutbox.payloadPostId,
  payloadRelationshipId: engagementOutbox.payloadRelationshipId,
  payloadPostOwnerOxyUserId: engagementOutbox.payloadPostOwnerOxyUserId,
  payloadFederationActivityId: engagementOutbox.payloadFederationActivityId,
  payloadPreviousValue: engagementOutbox.payloadPreviousValue,
  payloadValue: engagementOutbox.payloadValue,
  attempts: engagementOutbox.attempts,
  availableAt: engagementOutbox.availableAt,
  leaseOwner: engagementOutbox.leaseOwner,
  leaseUntil: engagementOutbox.leaseUntil,
  expiresAt: engagementOutbox.expiresAt,
  createdAt: engagementOutbox.createdAt,
} as const;

type EventRow = SelectedRow<typeof EVENT_COLUMNS>;

/**
 * Narrow a stored vote to the closed set the payload declares.
 *
 * TOTAL rather than throwing: `engagement_outbox_values_check` already forbids
 * anything but `1`, `-1` and NULL, so a third value is unreachable — and adding
 * a throw here would put a new failure path in front of a dispatcher whose whole
 * job is to be resilient.
 */
function voteValue(value: number | null): EngagementVoteValue | null {
  if (value === 1) return 1;
  if (value === -1) return -1;
  return null;
}

function toEvent(row: EventRow): EngagementOutboxEvent {
  return {
    id: row.id,
    kind: row.kind,
    revision: row.revision,
    payload: {
      actorOxyUserId: row.payloadActorOxyUserId,
      postId: row.payloadPostId,
      relationshipId: row.payloadRelationshipId,
      // Drizzle hands back `null` where Mongoose handed back `undefined`, and
      // every consumer of these two is typed `string | undefined`.
      postOwnerOxyUserId: row.payloadPostOwnerOxyUserId ?? undefined,
      federationActivityId: row.payloadFederationActivityId ?? undefined,
      previousValue: voteValue(row.payloadPreviousValue),
      value: voteValue(row.payloadValue),
    },
    attempts: row.attempts,
    availableAt: row.availableAt,
    leaseOwner: row.leaseOwner ?? undefined,
    leaseUntil: row.leaseUntil ?? undefined,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

function normalizeRevision(revision: number): number {
  const truncated = Math.trunc(revision);
  return Number.isSafeInteger(truncated) && truncated > 0 ? truncated : 1;
}

/**
 * Derive a stable id from the relationship transition, not the HTTP request.
 * Transaction retries and concurrent duplicate requests therefore upsert the
 * same event. `revision` makes repeated like↔downvote transitions distinct.
 */
export function engagementOutboxEventId(
  kind: EngagementOutboxKind,
  relationshipId: string,
  revision: number,
): string {
  const normalizedRevision = normalizeRevision(revision);
  return `engagement:${kind}:${relationshipId}:v${normalizedRevision}`;
}

/**
 * Insert the event inside the caller's transaction. Failure aborts the command.
 *
 * @param tx The OPEN transaction that owns the relationship write. Typed as
 *   `Transaction` rather than `DatabaseOrTransaction` on purpose: the pool
 *   handle is not assignable to it, so "enqueue outside the transaction" is a
 *   compile error rather than a silently non-atomic write.
 */
export async function enqueueEngagementOutboxEvent(
  input: EnqueueEngagementEventInput,
  tx: Transaction,
): Promise<string> {
  const eventId = engagementOutboxEventId(
    input.kind,
    input.relationshipId,
    input.revision,
  );
  const now = new Date();
  await tx
    .insert(engagementOutbox)
    .values({
      id: eventId,
      kind: input.kind,
      revision: normalizeRevision(input.revision),
      payloadActorOxyUserId: input.payload.actorOxyUserId,
      payloadPostId: input.payload.postId,
      payloadRelationshipId: input.payload.relationshipId,
      payloadPostOwnerOxyUserId: input.payload.postOwnerOxyUserId ?? null,
      payloadFederationActivityId: input.payload.federationActivityId ?? null,
      payloadPreviousValue: input.payload.previousValue ?? null,
      payloadValue: input.payload.value ?? null,
      status: 'pending',
      attempts: 0,
      // One instant for both, so the claim's `available_at <= now` gate and its
      // `created_at` ordering describe the same moment.
      availableAt: now,
      expiresAt: new Date(
        now.getTime() + ENGAGEMENT_OUTBOX_RETENTION_SECONDS * 1_000,
      ),
      createdAt: now,
      updatedAt: now,
    })
    // The replay no-op. `DO UPDATE` here would move `updated_at` on a row a
    // dispatcher may be holding uncommitted, which is the collision the
    // deterministic id exists to prevent.
    .onConflictDoNothing({ target: engagementOutbox.id });
  return eventId;
}

/**
 * Atomically claim one due event.
 *
 * `FOR UPDATE SKIP LOCKED` inside the id subquery is what makes N workers share
 * the table without contending: a row another worker is already claiming is
 * skipped rather than waited on. An expired `processing` lease is due again, so
 * a dead worker cannot strand its event forever.
 *
 * The ordering is `created_at ASC`, and `created_at` is NOT NULL — worth stating
 * because the trap here is real: Mongo sorts a MISSING value first while
 * Postgres sorts NULLs LAST, so a batch-bounded sweep ordered on a nullable
 * column would never reach the oldest row. Nothing in this table's claim path
 * orders on a nullable column; if one is ever added it needs `NULLS FIRST`.
 */
export async function claimEngagementOutboxEvent(options: {
  leaseOwner: string;
  eventId?: string;
  now?: Date;
  leaseMs?: number;
}): Promise<EngagementOutboxEvent | null> {
  const now = options.now ?? new Date();
  const leaseMs = Math.max(MIN_LEASE_MS, options.leaseMs ?? DEFAULT_LEASE_MS);
  const db = getDb();

  const due = db
    .select({ id: engagementOutbox.id })
    .from(engagementOutbox)
    .where(
      and(
        options.eventId === undefined
          ? undefined
          : eq(engagementOutbox.id, options.eventId),
        or(
          and(
            eq(engagementOutbox.status, 'pending'),
            lte(engagementOutbox.availableAt, now),
          ),
          // A NULL `lease_until` never satisfies `<= now`, which is the same
          // answer Mongo's `$lte` gave for a missing field.
          and(
            eq(engagementOutbox.status, 'processing'),
            lte(engagementOutbox.leaseUntil, now),
          ),
        ),
      ),
    )
    .orderBy(asc(engagementOutbox.createdAt))
    .limit(1)
    .for('update', { skipLocked: true });

  const [claimed] = await db
    .update(engagementOutbox)
    .set({
      status: 'processing',
      leaseOwner: options.leaseOwner,
      leaseUntil: new Date(now.getTime() + leaseMs),
      attempts: sql`${engagementOutbox.attempts} + 1`,
      lastError: null,
      updatedAt: now,
    })
    .where(inArray(engagementOutbox.id, due))
    .returning(EVENT_COLUMNS);

  return claimed ? toEvent(claimed) : null;
}

/**
 * Whether a LOWER revision for the same relationship is still unfinished.
 *
 * `status <> 'processed'` is total here because the column is NOT NULL — the
 * Mongo `$ne` also matched documents missing the field, and there are none.
 */
async function hasEarlierUnprocessedRevision(
  event: EngagementOutboxEvent,
): Promise<boolean> {
  const [earlier] = await getDb()
    .select({ id: engagementOutbox.id })
    .from(engagementOutbox)
    .where(
      and(
        eq(engagementOutbox.payloadRelationshipId, event.payload.relationshipId),
        lt(engagementOutbox.revision, event.revision),
        ne(engagementOutbox.status, 'processed'),
      ),
    )
    .limit(1);
  return earlier !== undefined;
}

/** The predicate every owner-checked transition shares: MY live lease, still live. */
function ownedLease(eventId: string, leaseOwner: string, now: Date) {
  return and(
    eq(engagementOutbox.id, eventId),
    eq(engagementOutbox.status, 'processing'),
    eq(engagementOutbox.leaseOwner, leaseOwner),
    gt(engagementOutbox.leaseUntil, now),
  );
}

/**
 * Return a claimed event to the queue without counting the claim as a delivery
 * attempt. A lower revision for the same relationship is still pending or
 * processing, so applying this transition now could resurrect a stale Like after
 * its Undo on another worker.
 */
async function deferOutOfOrderEvent(
  eventId: string,
  leaseOwner: string,
  now: Date = new Date(),
): Promise<boolean> {
  const released = await getDb()
    .update(engagementOutbox)
    .set({
      status: 'pending',
      availableAt: new Date(now.getTime() + ORDERING_DEFERRAL_MS),
      attempts: sql`${engagementOutbox.attempts} - 1`,
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: now,
    })
    .where(ownedLease(eventId, leaseOwner, now))
    .returning({ id: engagementOutbox.id });
  return released.length === 1;
}

/** Complete only the lease currently owned by this dispatcher. */
export async function completeEngagementOutboxEvent(
  eventId: string,
  leaseOwner: string,
  now: Date = new Date(),
): Promise<boolean> {
  const completed = await getDb()
    .update(engagementOutbox)
    .set({
      status: 'processed',
      processedAt: now,
      leaseOwner: null,
      leaseUntil: null,
      lastError: null,
      updatedAt: now,
    })
    .where(ownedLease(eventId, leaseOwner, now))
    .returning({ id: engagementOutbox.id });
  return completed.length === 1;
}

/**
 * Extend only a live lease still owned by this dispatcher.
 *
 * Mongo distinguished `matchedCount` from `modifiedCount` here because writing
 * the same `leaseUntil` twice modified nothing; Postgres has no such split — a
 * row that matched was updated — so the returned row IS the ownership answer.
 */
export async function renewEngagementOutboxEvent(
  eventId: string,
  leaseOwner: string,
  leaseMs: number,
  now: Date = new Date(),
): Promise<boolean> {
  const boundedLeaseMs = Math.max(MIN_LEASE_MS, leaseMs);
  const renewed = await getDb()
    .update(engagementOutbox)
    .set({
      leaseUntil: new Date(now.getTime() + boundedLeaseMs),
      updatedAt: now,
    })
    .where(ownedLease(eventId, leaseOwner, now))
    .returning({ id: engagementOutbox.id });
  return renewed.length === 1;
}

function nextAttemptAt(attempts: number, now: Date): Date {
  const exponent = Math.max(0, Math.min(attempts - 1, 10));
  const delayMs = Math.min(1_000 * (2 ** exponent), MAX_BACKOFF_MS);
  return new Date(now.getTime() + delayMs);
}

/** Release a failed claim with bounded exponential backoff. */
export async function failEngagementOutboxEvent(
  event: Pick<EngagementOutboxEvent, 'id' | 'attempts'>,
  leaseOwner: string,
  error: unknown,
  now: Date = new Date(),
): Promise<boolean> {
  const message = error instanceof Error ? error.message : String(error);
  const released = await getDb()
    .update(engagementOutbox)
    .set({
      status: 'pending',
      availableAt: nextAttemptAt(event.attempts, now),
      lastError: message.slice(0, MAX_LAST_ERROR_LENGTH),
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: now,
    })
    .where(ownedLease(event.id, leaseOwner, now))
    .returning({ id: engagementOutbox.id });
  return released.length === 1;
}

export type EngagementOutboxHandler = (
  event: EngagementOutboxEvent,
) => Promise<void>;

interface LeaseHeartbeatResult {
  lost: boolean;
  error?: unknown;
}

function startLeaseHeartbeat(options: {
  eventId: string;
  leaseOwner: string;
  leaseMs: number;
}): { stop: () => Promise<LeaseHeartbeatResult> } {
  const renewIntervalMs = Math.max(
    MIN_LEASE_RENEW_INTERVAL_MS,
    Math.floor(options.leaseMs / 3),
  );
  let stopped = false;
  let lost = false;
  let renewalError: unknown;
  let renewalInFlight: Promise<void> | null = null;

  const renew = (): void => {
    if (stopped || lost || renewalInFlight) return;
    const renewal = renewEngagementOutboxEvent(
      options.eventId,
      options.leaseOwner,
      options.leaseMs,
    )
      .then((stillOwner) => {
        if (!stillOwner) {
          lost = true;
        }
      })
      .catch((error) => {
        lost = true;
        renewalError = error;
      })
      .finally(() => {
        if (renewalInFlight === renewal) renewalInFlight = null;
      });
    renewalInFlight = renewal;
  };

  const timer = setInterval(renew, renewIntervalMs);
  timer.unref?.();

  return {
    async stop(): Promise<LeaseHeartbeatResult> {
      stopped = true;
      clearInterval(timer);
      await renewalInFlight;
      return { lost, error: renewalError };
    },
  };
}

/**
 * Reusable, bounded at-least-once dispatcher.
 *
 * Handlers MUST make each downstream write idempotent with `event.id`. The
 * concrete dispatcher uses strict notification/MTN/federation helpers that
 * surface persistence or enqueue failures. Relationship revisions are applied in
 * order even when several backend tasks claim work concurrently.
 */
export async function dispatchEngagementOutbox(options: {
  handler: EngagementOutboxHandler;
  leaseOwner?: string;
  batchSize?: number;
  leaseMs?: number;
  signal?: AbortSignal;
}): Promise<{ processed: number; failed: number }> {
  const leaseOwner = options.leaseOwner ?? `engagement:${process.pid}:${randomUUID()}`;
  const batchSize = Math.min(
    Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE),
    MAX_BATCH_SIZE,
  );
  const leaseMs = Math.max(MIN_LEASE_MS, options.leaseMs ?? DEFAULT_LEASE_MS);
  let processed = 0;
  let failed = 0;

  for (let index = 0; index < batchSize; index += 1) {
    // Shutdown stops claiming new work but lets the event already being handled
    // reach a durable processed/pending state.
    if (options.signal?.aborted) break;

    const event = await claimEngagementOutboxEvent({
      leaseOwner,
      leaseMs,
    });
    if (!event) break;

    if (await hasEarlierUnprocessedRevision(event)) {
      const deferred = await deferOutOfOrderEvent(event.id, leaseOwner);
      if (!deferred) {
        failed += 1;
        logger.warn('[EngagementOutbox] lease lost before ordering deferral', {
          eventId: event.id,
          kind: event.kind,
        });
      }
      continue;
    }

    const heartbeat = startLeaseHeartbeat({
      eventId: event.id,
      leaseOwner,
      leaseMs,
    });
    let deliveryError: unknown;
    try {
      await options.handler(event);
    } catch (error) {
      deliveryError = error;
    }

    // No completion/failure transition may race an owner-checked renewal.
    const heartbeatResult = await heartbeat.stop();
    if (heartbeatResult.lost) {
      failed += 1;
      logger.warn('[EngagementOutbox] event lease lost during delivery', {
        eventId: event.id,
        kind: event.kind,
        attempts: event.attempts,
        error:
          heartbeatResult.error instanceof Error
            ? heartbeatResult.error.message
            : heartbeatResult.error
              ? String(heartbeatResult.error)
              : 'owner or lease expiry changed',
      });
      continue;
    }

    if (deliveryError) {
      failed += 1;
      const released = await failEngagementOutboxEvent(
        event,
        leaseOwner,
        deliveryError,
      );
      logger.warn('[EngagementOutbox] event delivery failed', {
        eventId: event.id,
        kind: event.kind,
        attempts: event.attempts,
        error:
          deliveryError instanceof Error
            ? deliveryError.message
            : String(deliveryError),
      });
      if (!released) {
        logger.warn('[EngagementOutbox] lease lost before failure release', {
          eventId: event.id,
          kind: event.kind,
          attempts: event.attempts,
        });
      }
      continue;
    }

    const completed = await completeEngagementOutboxEvent(event.id, leaseOwner);
    if (!completed) {
      failed += 1;
      logger.warn('[EngagementOutbox] lease lost before completion', {
        eventId: event.id,
        kind: event.kind,
        attempts: event.attempts,
      });
      continue;
    }
    processed += 1;
  }

  return { processed, failed };
}
