/**
 * `account_erasures` and `oxy_account_event_cursors`: the durable record of every
 * Oxy account deletion Mention has been told about, and how far the pull feed has
 * been read. The design is in `db/schema/accountErasures.ts`.
 *
 * Every write here is a single statement, so none of them needs a transaction:
 * the insert dedupes on `event_id` with `ON CONFLICT`, and the claim is one
 * conditional UPDATE, which is what makes it safe for two ECS tasks to race.
 */

import { and, eq, inArray, isNotNull, lt, ne, or, sql } from 'drizzle-orm';
import { qualified, sqlColumnName } from '@oxy.so/db';
import { getDb } from '../postgres';
import {
  accountErasures,
  oxyAccountEventCursors,
  type AccountErasureSource,
  type AccountErasureStatus,
} from '../schema/accountErasures';

/** What an intake path knows about an event when it records it. */
export interface AccountErasureRequest {
  eventId: string;
  oxyUserId: string;
  source: AccountErasureSource;
  reason: string;
  occurredAt: Date | null;
  retained: boolean;
  username: string | null;
}

/** The row as the job reads it. `counts` and content never leave through here. */
export interface AccountErasureRow {
  id: string;
  eventId: string;
  oxyUserId: string;
  source: AccountErasureSource;
  status: AccountErasureStatus;
  attempts: number;
  username: string | null;
  completedAt: Date | null;
}

const ROW_COLUMNS = {
  id: accountErasures.id,
  eventId: accountErasures.eventId,
  oxyUserId: accountErasures.oxyUserId,
  source: accountErasures.source,
  status: accountErasures.status,
  attempts: accountErasures.attempts,
  username: accountErasures.username,
  completedAt: accountErasures.completedAt,
} as const;

/**
 * Record an event, or find the row an earlier delivery of it already wrote.
 *
 * `inserted` is `false` for a redelivery. The row's status is untouched on a
 * redelivery, so a completed erasure stays completed and a running one keeps its
 * lease. The only field a redelivery may fill is a `username` the first delivery
 * lacked, because the handle is what lets the `Delete` activities be addressed.
 */
export async function recordAccountErasureRequest(
  request: AccountErasureRequest,
): Promise<{ inserted: boolean; row: AccountErasureRow }> {
  const db = getDb();
  const [inserted] = await db
    .insert(accountErasures)
    .values({
      eventId: request.eventId,
      oxyUserId: request.oxyUserId,
      source: request.source,
      reason: request.reason,
      occurredAt: request.occurredAt,
      retained: request.retained,
      username: request.username,
    })
    .onConflictDoNothing({ target: accountErasures.eventId })
    .returning(ROW_COLUMNS);
  if (inserted) return { inserted: true, row: inserted };

  if (request.username !== null) {
    await db
      .update(accountErasures)
      .set({ username: request.username })
      .where(and(eq(accountErasures.eventId, request.eventId), sql`${accountErasures.username} is null`));
  }
  const existing = await findAccountErasure(request.eventId);
  if (!existing) {
    // Only reachable if the row was deleted between the two statements, which
    // nothing in this codebase does. Refusing is better than inventing a row.
    throw new Error(`account_erasures row for event ${request.eventId} vanished during intake`);
  }
  if (existing.oxyUserId !== request.oxyUserId) {
    // One event id naming two accounts means a replay, a forged pull item or a
    // bug on the sending side. Never erase the second account on that basis.
    throw new Error(`account event ${request.eventId} was recorded for a different account`);
  }
  return { inserted: false, row: existing };
}

export async function findAccountErasure(eventId: string): Promise<AccountErasureRow | null> {
  const [row] = await getDb()
    .select(ROW_COLUMNS)
    .from(accountErasures)
    .where(eq(accountErasures.eventId, eventId))
    .limit(1);
  return row ?? null;
}

/**
 * Take the lease on an event's erasure. Returns the row when this caller now
 * owns the run, `null` when the run is already complete or another task holds a
 * live lease on this account.
 *
 * The per-ACCOUNT half of the predicate matters because two events can name one
 * account (an operator run, then Oxy's own event). Their steps are idempotent,
 * but running them concurrently would only produce lock contention on the same
 * rows.
 */
export async function claimAccountErasure(
  eventId: string,
  leaseMs: number,
): Promise<AccountErasureRow | null> {
  const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
  const other = sql`exists (
    select 1 from ${accountErasures} as other
    where other.${sql.identifier(sqlColumnName(accountErasures.oxyUserId))} = ${qualified(accountErasures.oxyUserId)}
      and other.${sql.identifier(sqlColumnName(accountErasures.eventId))} <> ${qualified(accountErasures.eventId)}
      and other.${sql.identifier(sqlColumnName(accountErasures.status))} = 'running'
      and other.${sql.identifier(sqlColumnName(accountErasures.leaseUntil))} > now()
  )`;
  const [row] = await getDb()
    .update(accountErasures)
    .set({
      status: 'running',
      attempts: sql`${accountErasures.attempts} + 1`,
      leaseUntil: sql`${leaseUntil}::timestamptz`,
      startedAt: sql`coalesce(${accountErasures.startedAt}, now())`,
    })
    .where(
      and(
        eq(accountErasures.eventId, eventId),
        ne(accountErasures.status, 'completed'),
        or(
          inArray(accountErasures.status, ['pending', 'failed']),
          lt(accountErasures.leaseUntil, sql`now()`),
        ),
        sql`not ${other}`,
      ),
    )
    .returning(ROW_COLUMNS);
  return row ?? null;
}

/** Extend a live lease, so a long erasure is not reclaimed mid-run. */
export async function renewAccountErasureLease(eventId: string, leaseMs: number): Promise<void> {
  const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
  await getDb()
    .update(accountErasures)
    .set({ leaseUntil: sql`${leaseUntil}::timestamptz` })
    .where(and(eq(accountErasures.eventId, eventId), eq(accountErasures.status, 'running')));
}

/** Remember the handle once it is known, for the delivery worker. */
export async function setAccountErasureUsername(eventId: string, username: string): Promise<void> {
  await getDb()
    .update(accountErasures)
    .set({ username })
    .where(and(eq(accountErasures.eventId, eventId), sql`${accountErasures.username} is null`));
}

export async function completeAccountErasure(
  eventId: string,
  counts: Record<string, number>,
): Promise<void> {
  await getDb()
    .update(accountErasures)
    .set({
      status: 'completed',
      completedAt: sql`now()`,
      leaseUntil: null,
      counts,
      lastError: null,
    })
    .where(eq(accountErasures.eventId, eventId));
}

/** Maximum stored error length. Step names and driver messages, never content. */
const MAX_ERROR_LENGTH = 1_000;

export async function failAccountErasure(eventId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await getDb()
    .update(accountErasures)
    .set({ status: 'failed', leaseUntil: null, lastError: message.slice(0, MAX_ERROR_LENGTH) })
    .where(and(eq(accountErasures.eventId, eventId), ne(accountErasures.status, 'completed')));
}

/**
 * Unfinished erasures the sweep should run: never started, failed, or running
 * under a lease that lapsed (the task died). `quietSinceMs` keeps the sweep off a
 * row the queue worker is about to pick up anyway.
 */
export async function findRetryableAccountErasures(
  limit: number,
  quietSinceMs: number,
): Promise<string[]> {
  const quietBefore = new Date(Date.now() - quietSinceMs).toISOString();
  const rows = await getDb()
    .select({ eventId: accountErasures.eventId })
    .from(accountErasures)
    .where(
      or(
        and(
          inArray(accountErasures.status, ['pending', 'failed']),
          lt(accountErasures.updatedAt, sql`${quietBefore}::timestamptz`),
        ),
        and(eq(accountErasures.status, 'running'), lt(accountErasures.leaseUntil, sql`now()`)),
      ),
    )
    .orderBy(accountErasures.updatedAt)
    .limit(limit);
  return rows.map((row) => row.eventId);
}

/**
 * Has Mention been told this account was deleted? Any row counts, not only a
 * completed one: from the moment the signed event is recorded, the profile must
 * stop being served, even while the erasure is still running.
 */
export async function isAccountErased(oxyUserId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: accountErasures.id })
    .from(accountErasures)
    .where(eq(accountErasures.oxyUserId, oxyUserId))
    .limit(1);
  return row !== undefined;
}

/**
 * The handle each erased sender had, for signing the `Delete` activities still in
 * the delivery queue after Oxy stopped resolving the account.
 */
export async function findErasedAccountUsernames(
  oxyUserIds: readonly string[],
): Promise<Map<string, string>> {
  if (oxyUserIds.length === 0) return new Map();
  const rows = await getDb()
    .select({ oxyUserId: accountErasures.oxyUserId, username: accountErasures.username })
    .from(accountErasures)
    .where(and(inArray(accountErasures.oxyUserId, [...oxyUserIds]), isNotNull(accountErasures.username)));
  const byUser = new Map<string, string>();
  for (const row of rows) if (row.username) byUser.set(row.oxyUserId, row.username);
  return byUser;
}

/** Clear handles past their retention. Returns how many were cleared. */
export async function scrubExpiredErasureUsernames(retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const cleared = await getDb()
    .update(accountErasures)
    .set({ username: null })
    .where(
      and(
        eq(accountErasures.status, 'completed'),
        isNotNull(accountErasures.username),
        lt(accountErasures.completedAt, sql`${cutoff}::timestamptz`),
      ),
    )
    .returning({ id: accountErasures.id });
  return cleared.length;
}

export async function readAccountEventCursor(feed: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ cursor: oxyAccountEventCursors.cursor })
    .from(oxyAccountEventCursors)
    .where(eq(oxyAccountEventCursors.id, feed))
    .limit(1);
  return row?.cursor ?? null;
}

export async function writeAccountEventCursor(feed: string, cursor: string): Promise<void> {
  await getDb()
    .insert(oxyAccountEventCursors)
    .values({ id: feed, cursor })
    .onConflictDoUpdate({
      target: oxyAccountEventCursors.id,
      set: { cursor, updatedAt: sql`now()` },
    });
}
