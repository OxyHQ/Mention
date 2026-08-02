/**
 * Expiry Sweep — the replacement for Mongo TTL indexes
 *
 * Postgres has no TTL index. Seven Mention models relied on one, so the
 * mechanism is defined ONCE here and every table that needs it adds a registry
 * entry rather than growing its own cleanup path.
 *
 * ## The shape
 *
 * A Mongo TTL index is `{ <field>: 1 }, { expireAfterSeconds: N }` — delete a
 * document once `<field>` is more than N seconds in the past. A registry entry
 * is exactly that pair, so no semantic can be lost in translation:
 *
 *   { table, column, retentionSeconds }  →  delete where column <= now() - N
 *
 * Both uses in Mention's schema collapse into it: `expireAfterSeconds: 0` on an
 * `expiresAt` column (the column IS the deadline) and `expireAfterSeconds: N` on
 * a birth column (`createdAt`, `at`, `calculatedAt`).
 *
 * ## THE RULE: a TTL index ported without a registry entry is unbounded growth
 *
 * Mongo reaped a TTL'd collection whether or not anybody remembered it existed.
 * Postgres does not, so porting a model that declares `expireAfterSeconds` and
 * NOT adding it here converts a self-limiting table into one that grows forever
 * — with no error, no failing test and no symptom at all until the disk fills.
 * There is nothing to notice, which is why this is a rule and not a habit:
 * porting a TTL'd model is TWO edits, the table and this registry, and neither
 * is optional. `__tests__/db/expiry.test.ts` is the gate — it pins the registry
 * to an exact table LIST, so a new TTL'd table fails it until it is named.
 *
 * ## Every entry was checked for INTENT, not just replicated
 *
 * A Mongo TTL index DELETES the document. The sibling oxy-api port found one
 * that had been written meaning "mark expired" and had been destroying
 * subscription history instead, so each of these says what deleting the row
 * actually costs. One of them — `engagement_outbox` — deletes UNPROCESSED work
 * and is flagged accordingly.
 *
 * ## Coexistence with reads
 *
 * Mongo's TTL monitor lags ~60s; a sweep lags one interval. Mention has no read
 * path that depends on a swept row already being GONE — every consumer either
 * filters on its own deadline (`available_at`, `lease_until`, `calculated_at >=
 * cutoff`) or is a rolling view where an extra old row is stale, never unsafe.
 * That means the sweep is housekeeping everywhere and no table's correctness
 * depends on the job running. Keep it that way: adding a read that relies on
 * absence turns the sweep interval into a correctness window.
 *
 * ## Scheduling
 *
 * `sweepExpiredRows` is the mechanism; wiring it to a schedule belongs with the
 * call-site port, alongside the leader-gated jobs already in
 * `services/FeedJobScheduler.ts`. Until then it is callable and tested, and
 * nothing reads a swept table yet.
 */

import { getTableName, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Database } from './postgres';
import {
  AUTHOR_FOLLOWER_SNAPSHOT_RETENTION_SECONDS,
  NOTIFICATION_RETENTION_SECONDS,
  TREND_GRAPH_RETENTION_SECONDS,
  TREND_SUMMARY_RETENTION_SECONDS,
  TRENDING_RETENTION_SECONDS,
  authorFollowerSnapshots,
  notifications,
  trendGraphs,
  trendSummaries,
  trending,
} from './schema/discovery';
import { FEED_INTERACTION_RETENTION_SECONDS, feedInteractions } from './schema/feeds';
// `MODERATION_*_RETENTION_SECONDS` are deliberately NOT imported: those two
// tables carry a written `expires_at` that the WRITER already computed from the
// retention constant, so the sweep's own retention is 0 (the column IS the
// deadline). Importing them here would imply a second, independent window.
import { moderationEvents, moderationOutbox } from './schema/moderation';
import { engagementOutbox } from './schema/outbox';

/**
 * Rows deleted per statement. Bounded so a large backlog cannot hold one long
 * transaction open — Mongo's TTL monitor deleted incrementally for the same
 * reason.
 */
const DEFAULT_BATCH_SIZE = 1000;

/**
 * Ceiling on batches per table per call, so one enormous table cannot starve the
 * others in the registry. The remainder is picked up on the next run.
 */
const DEFAULT_MAX_BATCHES = 50;

/** One table's expiry rule — the direct analogue of a Mongo TTL index. */
export interface ExpirySweepTarget {
  readonly table: PgTable;
  /** The date column the retention is measured from. Must be indexed. */
  readonly column: PgColumn;
  /** Seconds a row may survive past `column` before it is deleted. */
  readonly retentionSeconds: number;
  /** What deleting the row costs, in one line. */
  readonly reason: string;
}

/**
 * Every table that had a Mongo TTL index. A table with an expiry column but no
 * entry here is never swept.
 */
export const EXPIRY_SWEEP_TARGETS: readonly ExpirySweepTarget[] = [
  {
    table: trending,
    column: trending.calculatedAt,
    retentionSeconds: TRENDING_RETENTION_SECONDS,
    reason:
      'Housekeeping only — the trending job publishes a full batch every 30 ' +
      'minutes, and the history aggregation bounds its own window by the SAME ' +
      'constant, so nothing can ask for a row the sweep has taken.',
  },
  {
    table: trendSummaries,
    column: trendSummaries.generatedAt,
    retentionSeconds: TREND_SUMMARY_RETENTION_SECONDS,
    reason:
      'Derived text. A summary is regenerated on demand for whichever run is ' +
      'live, so deleting an old one costs nothing but a regeneration that ' +
      'demand would have to justify all over again.',
  },
  {
    table: trendGraphs,
    column: trendGraphs.calculatedAt,
    retentionSeconds: TREND_GRAPH_RETENTION_SECONDS,
    reason:
      'A rolling picture of recent batches, and the ONLY reader ' +
      '(`trendGraphQuery`) loads one batch by its own `calculated_at`, so a ' +
      'graph older than the window is already unreachable. It is also the ' +
      'largest row in the schema by some way — a whole batch of nodes and ' +
      'edges in two jsonb columns — which is why it kept a 7-day TTL where ' +
      'the trend rows it explains keep 90.',
  },
  {
    table: notifications,
    column: notifications.createdAt,
    retentionSeconds: NOTIFICATION_RETENTION_SECONDS,
    reason:
      'Bounds a collection nothing else ever deletes from — every like, reply, ' +
      'follow and mention adds a row. The list is a rolling recent view, so an ' +
      'old row is stale, never unsafe. `unread_count` is a separate aggregate ' +
      'and drops with the rows, which is correct: a 90-day-old unread ' +
      'notification is not a badge anyone wants.',
  },
  {
    table: authorFollowerSnapshots,
    column: authorFollowerSnapshots.at,
    retentionSeconds: AUTHOR_FOLLOWER_SNAPSHOT_RETENTION_SECONDS,
    reason:
      'A rolling time series. The `risingCreators` delta only ever reads ' +
      'first/last INSIDE its window, so a sample older than the retention is ' +
      'unreachable by construction.',
  },
  {
    table: feedInteractions,
    column: feedInteractions.createdAt,
    retentionSeconds: FEED_INTERACTION_RETENTION_SECONDS,
    reason:
      'Ranking-feedback telemetry, ninety days exactly as the Mongo TTL kept. ' +
      'The only reader (`evalFeedQuality`) bounds its own `createdAt >= since`.',
  },
  {
    table: moderationEvents,
    column: moderationEvents.expiresAt,
    retentionSeconds: 0,
    reason:
      'The row is BOTH the §10.8 dedupe record and the audit trail of what a ' +
      'third party told this deployment to do. §10.9\'s retry schedule ends at ' +
      '24 hours, so 90 days is far past the point a redelivery could arrive — ' +
      'the retention exists for the audit, and deleting reclaims storage only.',
  },
  {
    table: moderationOutbox,
    column: moderationOutbox.expiresAt,
    retentionSeconds: 0,
    reason:
      'Ceiling so a stalled dispatcher cannot make the outbox unbounded. NOTE ' +
      'that a `dead_letter` row is evidence somebody still has to look at, and ' +
      'this deletes it at 90 days — which is the documented intent, but it is ' +
      'the reason the reconciliation sweep COUNTS dead-lettered rows rather ' +
      'than assuming they persist.',
  },
  {
    table: engagementOutbox,
    column: engagementOutbox.expiresAt,
    retentionSeconds: 0,
    reason:
      'WARNING — this is the one entry that deletes UNPROCESSED WORK. The ' +
      'predicate is the deadline alone, not the status, so a `pending` event ' +
      'whose dispatcher has been stalled for the whole retention window is ' +
      'destroyed rather than retried, and the like/save it represents never ' +
      'reaches MTN, federation or notifications. The Mongoose model stated ' +
      'this is deliberate ("operational alerts must fire well before this ' +
      'deadline"), and the alerting is what makes it safe. THAT ALERTING DOES ' +
      'NOT EXIST: there is no engagement-outbox metric in `utils/metrics.ts` ' +
      '(so nothing is exported for `GET /internal/metrics` to serve), and ' +
      'oxy-infra defines no CloudWatch alarm, scraper or notification target ' +
      'for this or anything else. Until a backlog-age signal exists and is ' +
      'wired to somewhere a human reads, scheduling this sweep converts a ' +
      'stalled dispatcher from a recoverable incident into silent, permanent ' +
      'data loss. Sweep every other table; leave this one unscheduled.',
  },
];

/** Outcome of one sweep, for the caller to log or assert on. */
export interface ExpirySweepResult {
  readonly table: string;
  readonly deleted: number;
  /** True when the batch ceiling was hit and rows remain for the next run. */
  readonly truncated: boolean;
}

export interface ExpirySweepOptions {
  readonly batchSize?: number;
  readonly maxBatches?: number;
}

/**
 * `column <= now() - retentionSeconds`.
 *
 * The column is interpolated as a drizzle Column, not as
 * `sql.identifier(column.name)`: `column.name` is the TypeScript property name
 * (`expiresAt`), and only drizzle's own renderer applies the configured casing
 * to reach `expires_at` — see `db/casing.ts`.
 */
function expiredPredicate(target: ExpirySweepTarget): SQL {
  return sql`${target.column} <= now() - make_interval(secs => ${target.retentionSeconds})`;
}

/**
 * Delete every expired row from one target, in bounded batches.
 *
 * Batching goes through `ctid` (Postgres's physical row address) because
 * `DELETE ... LIMIT` is not valid SQL: the inner select takes the limit, the
 * outer delete removes exactly those rows.
 */
export async function sweepExpiredRows(
  db: Database,
  target: ExpirySweepTarget,
  options: ExpirySweepOptions = {}
): Promise<ExpirySweepResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
  const table = sql.identifier(getTableName(target.table));
  const expired = expiredPredicate(target);

  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const rows = await db.execute<{ ctid: string }>(sql`
      delete from ${table}
      where ctid in (
        select ctid from ${table} where ${expired} limit ${batchSize}
      )
      returning ctid
    `);

    deleted += rows.length;
    if (rows.length < batchSize) {
      return { table: getTableName(target.table), deleted, truncated: false };
    }
  }

  return { table: getTableName(target.table), deleted, truncated: true };
}

/**
 * Sweep every registered target. Runs them in sequence rather than in parallel:
 * this is background maintenance and should not contend with request traffic for
 * the connection pool.
 */
export async function sweepAllExpiredRows(
  db: Database,
  options: ExpirySweepOptions = {}
): Promise<ExpirySweepResult[]> {
  const results: ExpirySweepResult[] = [];
  for (const target of EXPIRY_SWEEP_TARGETS) {
    results.push(await sweepExpiredRows(db, target, options));
  }
  return results;
}
