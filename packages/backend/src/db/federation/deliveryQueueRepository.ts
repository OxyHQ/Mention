/**
 * `federation_delivery_queue` — the LEGACY durable outbound-delivery queue.
 *
 * Outbound delivery is BullMQ's now. This table survives for two reasons and
 * nothing else: it is the fallback the delivery engine writes to when Redis is
 * absent, and it holds rows written before the BullMQ migration that the startup
 * drain still hands over. It is a table with a planned end — do not build
 * anything new on it.
 *
 * ## The one predicate that does not survive a literal translation
 *
 * The drain selects rows `{ migratedToBullmq: { $ne: true } }`. Mongo's `$ne`
 * MATCHES a document where the field is absent, which is the whole population it
 * was written for — every row predating the column. `<> true` in SQL yields NULL
 * for a NULL column and NULL is not true, so the literal translation would drain
 * nothing. The column here is `NOT NULL DEFAULT false`, so even `= false` would
 * work today; `IS NOT TRUE` is used anyway because it is the predicate that stays
 * correct if the column is ever made nullable, and because the reason it is not
 * `<> true` should be visible where the query is.
 */

import { and, asc, count, eq, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { federationDeliveryQueue } from '../schema/federation';

type DeliveryRow = typeof federationDeliveryQueue.$inferSelect;

/**
 * The six retry tiers, in order. Kept beside the table they schedule rather than
 * in the queue constants: `queue/constants.ts` deliberately MIRRORS this ladder
 * for the BullMQ path, and two copies of a schedule drift the moment one is
 * tuned — so the copy that owns the rows lives here.
 */
const BACKOFF_INTERVALS_MS = [
  1 * 60 * 1000,       // 1 minute
  5 * 60 * 1000,       // 5 minutes
  30 * 60 * 1000,      // 30 minutes
  2 * 60 * 60 * 1000,  // 2 hours
  12 * 60 * 60 * 1000, // 12 hours
  48 * 60 * 60 * 1000, // 48 hours
];

/**
 * When to try delivery number `attempts` again, or `null` once the ladder is
 * exhausted — which the caller turns into a terminal `failed`.
 */
export function getNextRetryTime(attempts: number): Date | null {
  if (attempts >= BACKOFF_INTERVALS_MS.length) return null;
  return new Date(Date.now() + BACKOFF_INTERVALS_MS[attempts]);
}

/** One queued delivery, as the retry loop and the drain read it. */
export interface FederationDeliveryRecord {
  id: string;
  activityJson: Record<string, unknown>;
  targetInbox: string;
  senderOxyUserId: string;
  attempts: number;
  nextAttemptAt: Date;
  status: DeliveryRow['status'];
  lastAttemptAt?: Date;
  error?: string;
}

function assemble(row: DeliveryRow): FederationDeliveryRecord {
  return {
    id: row.id,
    // `jsonb` is typed `unknown` by drizzle because its shape is whatever was
    // stored. It is always a whole ActivityStreams document — the engine only
    // ever writes one — and every consumer hands it straight back to the signer.
    activityJson: row.activityJson as Record<string, unknown>,
    targetInbox: row.targetInbox,
    senderOxyUserId: row.senderOxyUserId,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    status: row.status,
    lastAttemptAt: row.lastAttemptAt ?? undefined,
    error: row.error ?? undefined,
  };
}

/** A delivery to persist when BullMQ is unavailable. */
export interface DeliveryQueueInsert {
  activityJson: Record<string, unknown>;
  targetInbox: string;
  senderOxyUserId: string;
  nextAttemptAt: Date;
}

/** Persist one fallback delivery. */
export async function insertDelivery(
  job: DeliveryQueueInsert,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.insert(federationDeliveryQueue).values(job);
}

/**
 * Persist several fallback deliveries in one write.
 *
 * The Mongo counterpart passed `{ ordered: false }` so one bad row could not stop
 * the rest. There is no per-row failure mode left to tolerate: the columns are
 * all `NOT NULL` values the caller has already built, and the table has no unique
 * constraint, so the only way a row fails is a way that fails the whole statement
 * either way.
 */
export async function insertDeliveries(
  jobs: readonly DeliveryQueueInsert[],
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  if (jobs.length === 0) return;
  await db.insert(federationDeliveryQueue).values([...jobs]);
}

/** Pending deliveries whose next attempt is due, oldest first. */
export async function findDueDeliveries(
  now: Date,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<FederationDeliveryRecord[]> {
  const rows = await db
    .select()
    .from(federationDeliveryQueue)
    .where(
      and(
        eq(federationDeliveryQueue.status, 'pending'),
        lte(federationDeliveryQueue.nextAttemptAt, now),
      ),
    )
    .orderBy(asc(federationDeliveryQueue.nextAttemptAt))
    .limit(limit);
  return rows.map(assemble);
}

/** Pending deliveries not yet handed to BullMQ, oldest first — the startup drain. */
export async function findUnmigratedDeliveries(
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<FederationDeliveryRecord[]> {
  const rows = await db
    .select()
    .from(federationDeliveryQueue)
    .where(
      and(
        eq(federationDeliveryQueue.status, 'pending'),
        sql`${federationDeliveryQueue.migratedToBullmq} is not true`,
      ),
    )
    .orderBy(asc(federationDeliveryQueue.nextAttemptAt))
    .limit(limit);
  return rows.map(assemble);
}

/** Mark rows as handed over, so a re-run of the drain cannot enqueue them twice. */
export async function markDeliveriesMigrated(
  ids: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(federationDeliveryQueue)
    .set({ migratedToBullmq: true, updatedAt: new Date() })
    .where(inArray(federationDeliveryQueue.id, [...ids]));
}

/**
 * Record the outcome of one delivery attempt.
 *
 * `error` is only written when the caller passes one. The Mongo success path
 * spelled `$set: { …, error: undefined }`, which Mongoose STRIPS — so a delivered
 * row kept whatever error its last failed attempt left behind. That is preserved
 * rather than "fixed": clearing it is a behaviour change, and the field is only
 * ever read by an operator looking at a `failed` row.
 */
export interface DeliveryAttemptOutcome {
  status?: DeliveryRow['status'];
  lastAttemptAt?: Date;
  nextAttemptAt?: Date;
  error?: string;
  /** Add one to the stored attempt count, in the same statement. */
  incrementAttempts?: boolean;
}

export async function recordDeliveryAttempt(
  id: string,
  outcome: DeliveryAttemptOutcome,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  // `PgUpdateSetSource`, not `Partial<$inferInsert>`: the attempt counter is
  // written as an expression over its own column, and only the update-set type
  // admits a `SQL` beside a plain value. Both spellings key by column PROPERTY,
  // so a stale name still fails `tsc` rather than writing nothing.
  const values: PgUpdateSetSource<typeof federationDeliveryQueue> = { updatedAt: new Date() };
  if (outcome.status !== undefined) values.status = outcome.status;
  if (outcome.lastAttemptAt !== undefined) values.lastAttemptAt = outcome.lastAttemptAt;
  if (outcome.nextAttemptAt !== undefined) values.nextAttemptAt = outcome.nextAttemptAt;
  if (outcome.error !== undefined) values.error = outcome.error;
  if (outcome.incrementAttempts) {
    // Read-modify-write in ONE statement: two workers that both time out on the
    // same delivery must not both read `attempts: 3` and both store `4`, which
    // would let the ladder run twice as long as it is configured to.
    values.attempts = sql`${federationDeliveryQueue.attempts} + 1`;
  }

  await db.update(federationDeliveryQueue).set(values).where(eq(federationDeliveryQueue.id, id));
}

/** Whether any queued delivery names this sender — the deletion preflight. */
export async function hasDeliveriesFromSender(
  senderOxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: federationDeliveryQueue.id })
    .from(federationDeliveryQueue)
    .where(eq(federationDeliveryQueue.senderOxyUserId, senderOxyUserId))
    .limit(1);
  return rows.length > 0;
}

/**
 * Whether any queued delivery references one of these AP object URIs — the
 * post-deletion preflight.
 *
 * Three JSON paths, because an activity names its subject in three shapes:
 * `{id}` for a bare object, `{object: {id}}` for an embedded one, and
 * `{object: "<uri>"}` for a reference. `->>` renders a JSON string as text and a
 * JSON object as its serialization, so the bare-reference path is the only one
 * `->>'object'` answers and the embedded one needs `->'object'->>'id'`.
 *
 * `inArray`, never `= any(${keys})`: a raw JS array binds as a ROW constructor
 * and Postgres raises `op ANY/ALL (array) requires array on right side`.
 */
function referencesObjects(objectUris: readonly string[]): SQL | undefined {
  const keys = [...objectUris];
  return or(
    inArray(sql<string>`${federationDeliveryQueue.activityJson}->>'id'`, keys),
    inArray(sql<string>`${federationDeliveryQueue.activityJson}->'object'->>'id'`, keys),
    inArray(sql<string>`${federationDeliveryQueue.activityJson}->>'object'`, keys),
  );
}

export async function hasDeliveriesReferencingObjects(
  objectUris: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  if (objectUris.length === 0) return false;

  const rows = await db
    .select({ id: federationDeliveryQueue.id })
    .from(federationDeliveryQueue)
    .where(referencesObjects(objectUris))
    .limit(1);
  return rows.length > 0;
}

/**
 * How many queued deliveries reference one of these AP object URIs.
 *
 * The dry-run half of {@link deleteDeliveriesReferencingObjects}, and it shares
 * the predicate with the probe above rather than restating it: the preflight
 * WAIVES `federation_delivery_queue.activity_json` on the strength of the purge's
 * cascade, so a delete asking a narrower question than the probe would clear a
 * gate for rows it then failed to remove.
 */
export async function countDeliveriesReferencingObjects(
  objectUris: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  if (objectUris.length === 0) return 0;
  const [row] = await db
    .select({ total: count() })
    .from(federationDeliveryQueue)
    .where(referencesObjects(objectUris));
  return row?.total ?? 0;
}

/** Remove every queued delivery naming one of these AP object URIs. */
export async function deleteDeliveriesReferencingObjects(
  objectUris: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  if (objectUris.length === 0) return 0;
  const removed = await db
    .delete(federationDeliveryQueue)
    .where(referencesObjects(objectUris))
    .returning({ id: federationDeliveryQueue.id });
  return removed.length;
}
