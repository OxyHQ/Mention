/**
 * `endorsement_outbox` — one row per `(source, source_id)` scope whose
 * endorsement edges still need pushing to Oxy.
 *
 * A desired-state outbox: the row records WHICH scope to re-sync, not what to
 * send, so a re-arm on an already-pending scope is a no-op rather than a second
 * unit of work. The unique `(source, source_id)` is what makes that true, and it
 * is the upsert target here.
 *
 * ## `attempts` is incremented in SQL, not read-modify-written
 *
 * The Mongo version read `attempts`, added one in JavaScript, and wrote the sum
 * back. Two drains overlapping on one scope therefore both read the same value
 * and both wrote the same successor, so the backoff stopped growing and a
 * permanently failing scope was retried at the first interval forever. The
 * increment is now the database's, inside a transaction with the write that
 * reads it back to compute the next attempt time.
 *
 * ## The backoff schedule lives here
 *
 * It moved with the table from `models/EndorsementOutbox.ts`. It is policy about
 * this row's retry cadence and has no other consumer.
 */

import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import {
  ENDORSEMENT_OUTBOX_STATUSES,
  ENDORSEMENT_SOURCES,
  endorsementOutbox,
} from '../schema/outbox';

/** Which membership model a scope belongs to. */
export type EndorsementSource = (typeof ENDORSEMENT_SOURCES)[number];
/** Pending = needs a (re)push; sent = the last push succeeded. */
export type EndorsementOutboxStatus = (typeof ENDORSEMENT_OUTBOX_STATUSES)[number];

/**
 * Exponential backoff schedule for failed pushes, indexed by attempt count.
 * Minutes → hours. Even an exhausted row is harmless to re-arm: the push is
 * desired-state, so the drain keeps retrying slowly rather than abandoning it.
 */
const BACKOFF_INTERVALS_MS = [
  1 * 60 * 1000,        // 1 minute
  5 * 60 * 1000,        // 5 minutes
  30 * 60 * 1000,       // 30 minutes
  2 * 60 * 60 * 1000,   // 2 hours
  12 * 60 * 60 * 1000,  // 12 hours
];

/** Largest backoff used once the schedule is exhausted (re-arm, never drop). */
const MAX_BACKOFF_MS = BACKOFF_INTERVALS_MS[BACKOFF_INTERVALS_MS.length - 1];

/**
 * The next attempt time for a given (1-based) attempt count. Clamps to the last
 * interval so an over-attempted row keeps retrying slowly rather than being
 * abandoned — desired-state pushes are cheap and self-healing.
 */
export function getEndorsementNextAttempt(attempts: number): Date {
  const index = Math.min(Math.max(attempts - 1, 0), BACKOFF_INTERVALS_MS.length - 1);
  const interval = attempts <= 0 ? 0 : BACKOFF_INTERVALS_MS[index] ?? MAX_BACKOFF_MS;
  return new Date(Date.now() + interval);
}

/** The removal edges a scope still owes, captured before its members were pruned. */
export interface PendingRemoval {
  ownerId?: string;
  memberIds?: string[];
}

/** One scope the drain must re-sync. */
export interface DueEndorsementScope {
  source: EndorsementSource;
  sourceId: string;
}

/** Matches exactly one scope's row. */
function scope(source: EndorsementSource, sourceId: string) {
  return and(eq(endorsementOutbox.source, source), eq(endorsementOutbox.sourceId, sourceId));
}

/**
 * Upsert the scope's row so it is `pending` and due now, optionally recording
 * members that must be retracted.
 *
 * The removal ids UNION with whatever is already recorded rather than replacing
 * it — this is Mongo's `$addToSet … $each`, and it matters because two removals
 * before a successful drain must both be retracted. Replacing would drop the
 * first, permanently: nothing recomputes a removal, since the members are gone
 * from the source document by then.
 *
 * The union is a locked read-modify-write rather than an expression in the
 * conflict clause: two arms racing one scope must not each read the pre-union
 * value, and `FOR UPDATE` on a row an `ON CONFLICT DO NOTHING` has just
 * guaranteed to exist is what serialises them.
 */
export async function armEndorsementScope(
  source: EndorsementSource,
  sourceId: string,
  removal?: { ownerId: string; memberIds: readonly string[] },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const now = new Date();
  const removed = removal
    ? [...new Set(removal.memberIds.filter((id) => id && id !== removal.ownerId))]
    : [];

  if (removal === undefined || removed.length === 0) {
    await db
      .insert(endorsementOutbox)
      .values({ source, sourceId, status: 'pending', attempts: 0, nextAttemptAt: now })
      .onConflictDoUpdate({
        target: [endorsementOutbox.source, endorsementOutbox.sourceId],
        // `attempts` is deliberately NOT reset: re-arming a scope that keeps
        // failing must not restart its backoff at one minute.
        set: { status: 'pending', nextAttemptAt: now },
      });
    return;
  }

  await db.transaction(async (tx) => {
    // Ensure the row exists before locking it — `FOR UPDATE` cannot lock a row
    // that is not there, so a concurrent first-arm would otherwise slip past.
    await tx
      .insert(endorsementOutbox)
      .values({
        source,
        sourceId,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
        pendingRemoveOwnerId: removal.ownerId,
        pendingRemoveMemberIds: removed,
      })
      .onConflictDoNothing({
        target: [endorsementOutbox.source, endorsementOutbox.sourceId],
      });

    const [existing] = await tx
      .select({ memberIds: endorsementOutbox.pendingRemoveMemberIds })
      .from(endorsementOutbox)
      .where(scope(source, sourceId))
      .for('update')
      .limit(1);

    if (!existing) return;

    await tx
      .update(endorsementOutbox)
      .set({
        status: 'pending',
        nextAttemptAt: now,
        pendingRemoveOwnerId: removal.ownerId,
        pendingRemoveMemberIds: [...new Set([...(existing.memberIds ?? []), ...removed])],
      })
      .where(scope(source, sourceId));
  });
}

/** The removal edges recorded against a scope, for the next push. */
export async function loadPendingRemoval(
  source: EndorsementSource,
  sourceId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<PendingRemoval> {
  const [row] = await db
    .select({
      ownerId: endorsementOutbox.pendingRemoveOwnerId,
      memberIds: endorsementOutbox.pendingRemoveMemberIds,
    })
    .from(endorsementOutbox)
    .where(scope(source, sourceId))
    .limit(1);

  return {
    ownerId: row?.ownerId ?? undefined,
    memberIds: row?.memberIds ?? undefined,
  };
}

/**
 * Mark a scope's push as delivered, clearing the retry state.
 *
 * `error` is cleared explicitly. The Mongo write set it to `undefined`, which
 * Mongoose strips out of `$set` — so a row that had just succeeded went on
 * carrying the message from the last failure, and the only place that reads it
 * is a human debugging why a scope is stuck.
 */
export async function markEndorsementSent(
  source: EndorsementSource,
  sourceId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(endorsementOutbox)
    .set({
      status: 'sent',
      attempts: 0,
      lastAttemptAt: new Date(),
      error: null,
      pendingRemoveOwnerId: null,
      pendingRemoveMemberIds: null,
    })
    .where(scope(source, sourceId));
}

/**
 * Record a failed attempt and back the scope off, leaving it `pending`.
 *
 * @returns The new attempt count, or `null` when no row matched — which means
 *   the scope was cleared underneath the drain, NOT that it has zero attempts.
 */
export async function markEndorsementFailed(
  source: EndorsementSource,
  sourceId: string,
  message: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(endorsementOutbox)
      .set({
        status: 'pending',
        attempts: sql`${endorsementOutbox.attempts} + 1`,
        lastAttemptAt: new Date(),
        error: message,
      })
      .where(scope(source, sourceId))
      .returning({ attempts: endorsementOutbox.attempts });

    if (!row) return null;

    await tx
      .update(endorsementOutbox)
      .set({ nextAttemptAt: getEndorsementNextAttempt(row.attempts) })
      .where(scope(source, sourceId));

    return row.attempts;
  });
}

/** The current status of a scope's row, or `undefined` when it has none. */
export async function readEndorsementStatus(
  source: EndorsementSource,
  sourceId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<EndorsementOutboxStatus | undefined> {
  const [row] = await db
    .select({ status: endorsementOutbox.status })
    .from(endorsementOutbox)
    .where(scope(source, sourceId))
    .limit(1);
  return row?.status;
}

/** Drop a scope's row entirely — used when the scope itself is deleted. */
export async function clearEndorsementScope(
  source: EndorsementSource,
  sourceId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.delete(endorsementOutbox).where(scope(source, sourceId));
}

/** Pending scopes whose backoff has elapsed, oldest due first. */
export async function findDueEndorsementScopes(
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<DueEndorsementScope[]> {
  return db
    .select({ source: endorsementOutbox.source, sourceId: endorsementOutbox.sourceId })
    .from(endorsementOutbox)
    .where(
      and(
        eq(endorsementOutbox.status, 'pending'),
        lte(endorsementOutbox.nextAttemptAt, new Date()),
      ),
    )
    .orderBy(asc(endorsementOutbox.nextAttemptAt))
    .limit(limit);
}
