/**
 * The account-erasure ledger: `account_erasures` and `oxy_account_event_cursors`.
 *
 * When a person deletes their Oxy account, Oxy tells every relying application
 * with a signed `account.deleted` event (OxyHQ/Mention#1169). It pushes the event
 * to a webhook and also serves it from a pull feed. Mention has to erase what it
 * holds for that person. These two tables record that the erasure happened.
 *
 * ## `account_erasures` is the idempotency ledger AND the job's durable state
 *
 * One row per Oxy EVENT, unique on `event_id`. Oxy delivers at least once, by push
 * and by pull, and the same event id arrives on every retry of either. The row is
 * written BEFORE the webhook answers 202, so the acknowledgement means the event is
 * durably recorded. A crash after that is recovered by the reconciliation sweep,
 * never lost.
 *
 * The row also holds the erasure job's progress (`status`, `attempts`,
 * `lease_until`, `last_error`), because the job is a multi-minute, resumable walk
 * over a person's whole footprint. A BullMQ job id alone would be lost with Redis.
 * The lease is what makes a run single-flight per event across ECS tasks:
 * `claimErasure` is one conditional UPDATE, so two tasks never erase the same
 * event at once.
 *
 * ## What the row keeps about a person who asked to be forgotten
 *
 * Their Oxy account id, the event id and per-category row COUNTS. Never content.
 * The id is the ledger's key: without it a replayed event could not be recognised
 * as done, and "was this account erased, and when" could not be answered. It is a
 * pseudonymous key into an account that no longer exists.
 *
 * `username` is the one field that is more than that, and it is TEMPORARY. Mention
 * mints ActivityPub ids from the handle (`/ap/users/<username>`), and the queued
 * `Delete` activities are signed with a key addressed by it. Oxy has deleted the
 * account, so this is the only place the handle still exists. The delivery worker
 * reads it here to sign the Deletes that are still retrying. The reconciliation
 * sweep clears it once {@link ERASURE_USERNAME_RETENTION_DAYS} have passed since
 * completion, which is longer than the delivery queue's full retry budget.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';

/**
 * Where an erasure request came from. Stated so an operator reading the ledger can
 * tell a push that arrived from a pull that caught up from a hand-run script.
 */
export const ACCOUNT_ERASURE_SOURCES = ['webhook', 'reconciliation', 'operator'] as const;
export type AccountErasureSource = (typeof ACCOUNT_ERASURE_SOURCES)[number];

/**
 * `pending`: recorded, not yet run. `running`: a task holds the lease.
 * `completed`: every step converged. `failed`: the last attempt threw; the
 * reconciliation sweep retries it.
 */
export const ACCOUNT_ERASURE_STATUSES = ['pending', 'running', 'completed', 'failed'] as const;
export type AccountErasureStatus = (typeof ACCOUNT_ERASURE_STATUSES)[number];

/**
 * How long `username` outlives a completed erasure. The outbound delivery queue
 * retries a `Delete` for about 63 hours (1m, 5m, 30m, 2h, 12h, 48h), so 14 days
 * leaves margin for a slow drain and for the durable fallback queue.
 */
export const ERASURE_USERNAME_RETENTION_DAYS = 14;

function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export const accountErasures = pgTable(
  'account_erasures',
  {
    id: generatedId(),
    /** The erased Oxy account. No foreign key: Oxy owns identity (CONVENTIONS.md). */
    oxyUserId: text().notNull(),
    /**
     * The Oxy account-event id (`jti`), or `operator:<uuid>` for a hand-run
     * erasure. UNIQUE: this is the dedupe key for at-least-once delivery.
     */
    eventId: text().notNull(),
    source: text({ enum: ACCOUNT_ERASURE_SOURCES }).notNull(),
    /** Why the erasure ran, e.g. `account.deleted`. A label, never free text from a user. */
    reason: text().notNull(),
    /** When Oxy committed the deletion, as the event states it. */
    occurredAt: timestamptz(),
    /** `true` when Oxy archived the row to keep financial records. Erased either way. */
    retained: boolean().notNull().default(false),
    /** The handle at deletion time. TEMPORARY; see the module comment. */
    username: text(),
    status: text({ enum: ACCOUNT_ERASURE_STATUSES }).notNull().default('pending'),
    attempts: integer().notNull().default(0),
    /** Held while a task is running the erasure. A lapsed lease can be reclaimed. */
    leaseUntil: timestamptz(),
    startedAt: timestamptz(),
    completedAt: timestamptz(),
    /**
     * Rows affected per category (`likes.userId: 12`), from the last completed run.
     * `jsonb` because the key set is the erasure map's, not the schema's. A column
     * per category would be a migration for every new table the map covers.
     */
    counts: jsonb().$type<Record<string, number>>(),
    /** The last failure's message. Never content: step names and error text only. */
    lastError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('account_erasures_event_id_key').on(t.eventId),
    check('account_erasures_source_check', sql`${t.source} in (${sql.raw(inList(ACCOUNT_ERASURE_SOURCES))})`),
    check('account_erasures_status_check', sql`${t.status} in (${sql.raw(inList(ACCOUNT_ERASURE_STATUSES))})`),
    check('account_erasures_attempts_check', sql`${t.attempts} >= 0`),
    // "Was this account erased?" (the profile routes) and "is another run of this
    // account in flight?" (the claim) both read by account.
    index('account_erasures_oxy_user_id_idx').on(t.oxyUserId),
    // The sweep's retry scan: unfinished rows whose lease has lapsed.
    index('account_erasures_status_idx').on(t.status),
  ],
);

/**
 * `oxy_account_event_cursors` — how far the reconciliation sweep has read Oxy's
 * account-event feed. One row per feed (today only `account-events`).
 *
 * Kept in Postgres, not Redis, because losing it is not harmless in either
 * direction. A cursor reset to the start re-reads every event since launch, and a
 * cursor that raced ahead would skip events. The cursor only advances after every
 * event on a page has been recorded in `account_erasures`.
 */
export const oxyAccountEventCursors = pgTable('oxy_account_event_cursors', {
  /** The feed's name. A natural key: there is exactly one row per feed. */
  id: text().primaryKey(),
  /** The feed's opaque cursor, exactly as Oxy returned it. */
  cursor: text().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
