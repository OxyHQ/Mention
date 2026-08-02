/**
 * `moderation_outbox` — the durable promise to deliver a report or apply a
 * decision.
 *
 * The at-least-once contract is unchanged from the Mongo original: handlers MUST
 * make every downstream effect idempotent using the event id, because an expired
 * lease is reclaimable and a worker can die mid-delivery.
 *
 * ## The claim is `FOR UPDATE SKIP LOCKED`, not a findOneAndUpdate
 *
 * Mongo claimed with an atomic `findOneAndUpdate` over a disjunctive filter.
 * Postgres has a better primitive for exactly this: `SELECT … FOR UPDATE SKIP
 * LOCKED` in the same statement as the update, so N dispatchers draining the
 * queue never hand each other the same row and never block on one another. The
 * predicate is otherwise identical — a `pending` row that is due, or a
 * `processing` row whose lease has expired.
 *
 * ## `timestamps: false` has no counterpart here, and that is the point
 *
 * The Mongo enqueue carried a long comment about writing `createdAt`/`updatedAt`
 * explicitly under `timestamps: false`, because Mongoose otherwise named
 * `updatedAt` in two operators of one update and Mongo rejected the whole write —
 * which, inside `createReport`'s transaction, took the `Report` with it. Drizzle
 * has no implicit timestamping on a conflict branch: `$onUpdate` fires only for
 * an `update()`, and the `DO NOTHING` below writes nothing at all. So a repeated
 * enqueue is a genuine no-op for the same structural reason the Mongo version
 * worked so hard to achieve, rather than by matching its spelling.
 */

import { and, asc, eq, gt, lte, or, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import {
  MODERATION_OUTBOX_KINDS,
  MODERATION_OUTBOX_RETENTION_SECONDS,
  MODERATION_OUTBOX_STATUSES,
  moderationOutbox,
} from '../schema/moderation';
import { requireTransaction } from './transactionGuard';

/** What kind of work an event represents. */
export type ModerationOutboxKind = (typeof MODERATION_OUTBOX_KINDS)[number];
/** Where an event is in its delivery lifecycle. */
export type ModerationOutboxStatus = (typeof MODERATION_OUTBOX_STATUSES)[number];

/**
 * The payload, across four nullable columns.
 *
 * A flat optional shape rather than a discriminated union, matching what the
 * workers read: each already knows its own `kind` from the event it claimed, and
 * a union would force a narrowing step at every call site that adds nothing.
 */
export interface ModerationOutboxPayload {
  /** The local report id, for `report.submit`. */
  reportId?: string;
  /** The inbound webhook event id, for `decision.apply` (Appendix D). */
  eventId?: string;
  /** The CrowdSource case a decision belongs to. */
  caseId?: string;
  /** The decision exactly as CrowdSource published it — whole and opaque. */
  decision?: unknown;
}

/** One claimed event, in the shape the dispatcher consumes. */
export interface ModerationOutboxEvent {
  _id: string;
  kind: ModerationOutboxKind;
  payload: ModerationOutboxPayload;
  attempts: number;
  availableAt: Date;
  leaseOwner?: string;
  leaseUntil?: Date;
  expiresAt: Date;
  createdAt: Date;
}

type OutboxRow = typeof moderationOutbox.$inferSelect;

/**
 * Reassemble the payload from its columns.
 *
 * `report.submit` carries only a report id; `decision.apply` carries the webhook
 * event id plus the case and the decision document. The decision stays `jsonb`
 * deliberately (§10.11 makes a published decision LOOSE, and projecting it into
 * columns would silently drop whatever a newer CrowdSource added).
 */
function toPayload(row: OutboxRow): ModerationOutboxPayload {
  return {
    ...(row.payloadReportId === null ? {} : { reportId: row.payloadReportId }),
    ...(row.payloadEventId === null ? {} : { eventId: row.payloadEventId }),
    ...(row.payloadCaseId === null ? {} : { caseId: row.payloadCaseId }),
    ...(row.payloadDecision === null ? {} : { decision: row.payloadDecision }),
  };
}

function toEvent(row: OutboxRow): ModerationOutboxEvent {
  return {
    _id: row.id,
    kind: row.kind,
    payload: toPayload(row),
    attempts: row.attempts,
    availableAt: row.availableAt,
    leaseOwner: row.leaseOwner ?? undefined,
    leaseUntil: row.leaseUntil ?? undefined,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/** Split a payload back into the columns that hold it. */
function payloadColumns(payload: ModerationOutboxPayload) {
  return {
    payloadReportId: payload.reportId ?? null,
    payloadEventId: payload.eventId ?? null,
    payloadCaseId: payload.caseId ?? null,
    payloadDecision: payload.decision ?? null,
  };
}

/**
 * Write the event with the CALLER's transaction.
 *
 * The transaction is required, not optional — this is the whole point of the
 * table: the domain write and this row commit together or not at all. See
 * `transactionGuard.ts` for why the type alone cannot express that, and what a
 * caller passing `getDb()` would otherwise get away with.
 *
 * This is also the ONLY writer of this table — the dispatcher claims existing
 * rows and never creates one — so no second queue can drift out of sync with the
 * outbox: the row IS the job.
 *
 * `ON CONFLICT DO NOTHING` keeps a repeat a genuine no-op. A repeat is ordinary
 * (a transaction retry, two concurrent duplicate submissions, a reconciliation
 * sweep re-deriving this deterministic id) and it runs while the dispatcher is
 * claiming and renewing leases on these same rows, so a write nobody needed would
 * contend with a live lease.
 */
export async function enqueueModerationOutboxEvent(
  input: {
    eventId: string;
    kind: ModerationOutboxKind;
    payload: ModerationOutboxPayload;
  },
  db: DatabaseOrTransaction,
): Promise<string> {
  const tx = requireTransaction(db, 'enqueueModerationOutboxEvent');
  const now = new Date();

  await tx
    .insert(moderationOutbox)
    .values({
      id: input.eventId,
      kind: input.kind,
      ...payloadColumns(input.payload),
      status: 'pending',
      attempts: 0,
      availableAt: now,
      expiresAt: new Date(now.getTime() + MODERATION_OUTBOX_RETENTION_SECONDS * 1_000),
    })
    .onConflictDoNothing({ target: moderationOutbox.id });

  return input.eventId;
}

/**
 * Atomically claim one due event.
 *
 * An expired `processing` lease is reclaimable, so a dead worker cannot strand
 * moderation work forever. `SKIP LOCKED` is what lets several dispatchers drain
 * the queue concurrently without handing each other the same row.
 */
export async function claimModerationOutboxEvent(
  options: {
    leaseOwner: string;
    eventId?: string;
    now?: Date;
    leaseMs?: number;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<ModerationOutboxEvent | null> {
  const now = options.now ?? new Date();
  const leaseMs = Math.max(1_000, options.leaseMs ?? 60_000);

  const due = and(
    options.eventId ? eq(moderationOutbox.id, options.eventId) : undefined,
    or(
      and(eq(moderationOutbox.status, 'pending'), lte(moderationOutbox.availableAt, now)),
      and(eq(moderationOutbox.status, 'processing'), lte(moderationOutbox.leaseUntil, now)),
    ),
  );

  const claimed = await db
    .update(moderationOutbox)
    .set({
      status: 'processing',
      leaseOwner: options.leaseOwner,
      leaseUntil: new Date(now.getTime() + leaseMs),
      attempts: sql`${moderationOutbox.attempts} + 1`,
      lastError: null,
    })
    .where(
      sql`${moderationOutbox.id} = (
        select ${moderationOutbox.id} from ${moderationOutbox}
        where ${due}
        order by ${asc(moderationOutbox.createdAt)}
        limit 1
        for update skip locked
      )`,
    )
    .returning();

  return claimed[0] ? toEvent(claimed[0]) : null;
}

/** Only the lease this dispatcher currently owns matches. */
function ownedLease(eventId: string, leaseOwner: string, now: Date) {
  return and(
    eq(moderationOutbox.id, eventId),
    eq(moderationOutbox.status, 'processing'),
    eq(moderationOutbox.leaseOwner, leaseOwner),
    gt(moderationOutbox.leaseUntil, now),
  );
}

/** Complete only the lease this dispatcher currently owns. */
export async function completeModerationOutboxEvent(
  eventId: string,
  leaseOwner: string,
  now: Date = new Date(),
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const completed = await db
    .update(moderationOutbox)
    .set({
      status: 'processed',
      processedAt: now,
      leaseOwner: null,
      leaseUntil: null,
      lastError: null,
    })
    .where(ownedLease(eventId, leaseOwner, now))
    .returning({ id: moderationOutbox.id });
  return completed.length === 1;
}

/** Extend only a live lease still owned by this dispatcher. */
export async function renewModerationOutboxEvent(
  eventId: string,
  leaseOwner: string,
  leaseMs: number,
  now: Date = new Date(),
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const renewed = await db
    .update(moderationOutbox)
    .set({ leaseUntil: new Date(now.getTime() + Math.max(1_000, leaseMs)) })
    .where(ownedLease(eventId, leaseOwner, now))
    .returning({ id: moderationOutbox.id });
  return renewed.length === 1;
}

/**
 * Release a failed claim, with backoff — or stop.
 *
 * `deadLettered` is the caller's decision (it knows whether the error was
 * retryable and how many attempts have been spent); this only writes it.
 */
export async function releaseModerationOutboxEvent(
  options: {
    eventId: string;
    leaseOwner: string;
    deadLettered: boolean;
    availableAt: Date;
    error: string;
    now?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = options.now ?? new Date();
  const released = await db
    .update(moderationOutbox)
    .set({
      status: options.deadLettered ? 'dead_letter' : 'pending',
      availableAt: options.availableAt,
      lastError: options.error.slice(0, 2_000),
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(ownedLease(options.eventId, options.leaseOwner, now))
    .returning({ id: moderationOutbox.id });
  return released.length === 1;
}

/**
 * The status of one event, or `undefined` when there is no such event.
 *
 * `undefined` means "no delivery event exists" — which the reconciliation sweep
 * acts on by re-deriving one — and is deliberately distinguishable from
 * `'dead_letter'`, which it must COUNT and never re-queue.
 */
export async function readModerationOutboxStatus(
  eventId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ModerationOutboxStatus | undefined> {
  const [row] = await db
    .select({ status: moderationOutbox.status })
    .from(moderationOutbox)
    .where(eq(moderationOutbox.id, eventId))
    .limit(1);
  return row?.status;
}

/** One event by id, whatever its state. Used by the reconciliation sweep. */
export async function findModerationOutboxEvent(
  eventId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ModerationOutboxEvent | undefined> {
  const [row] = await db
    .select()
    .from(moderationOutbox)
    .where(eq(moderationOutbox.id, eventId))
    .limit(1);
  return row ? toEvent(row) : undefined;
}
