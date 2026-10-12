/**
 * Expiry Sweep registry — Mention's TTL rules
 *
 * Postgres has no TTL index. Several Mention tables need one, so every table that needs it adds an entry here rather than growing
 * its own cleanup path. The registry stays here because it names THIS schema's
 * own tables; the mechanism that sweeps it (`sweepExpiredRows`,
 * `sweepAllExpiredRows`, `ExpirySweepTarget`) lives in `@oxy.so/db/expiry` — see
 * that module's doc comment for the full shape.
 *
 * ## THE RULE, because it is the quietest failure in this file's subject
 *
 * **Nothing reaps a Postgres table on its own.** A table added without a
 * registry entry grows FOREVER — no error, no failing test, no symptom of any
 * kind until disk. It is structurally invisible: there is no missing call site
 * and no orphaned function, nothing a reviewer diffing the change would see go
 * absent.
 *
 * There is no other declaration a walk could derive this list from.
 *
 * **So the registry is the WHOLE obligation, and `__tests__/db/expiry.test.ts`
 * holds it EXACT in both directions** — a table that lost its entry and a table
 * that never had one fail the same way. Two arrived exactly that way,
 * `mcp_auth_codes` and `trend_graphs`, each added without an entry until that
 * test said so. Deleting an entry alongside a table's last writer is the obvious
 * tidy-up and is exactly the failure this guards.
 *
 * ## The shape
 *
 * A TTL rule is a (field, N) pair — delete a row once `<field>` is more than N
 * seconds in the past. A registry entry is exactly that pair:
 *
 *   { table, column, retentionSeconds }  →  delete where column <= now() - N
 *
 * Both uses in Mention's schema collapse into it: N = 0 on an
 * `expiresAt` column (the column IS the deadline) and N > 0 on
 * a birth column (`createdAt`, `at`, `calculatedAt`).
 *
 * ## THE RULE: a table that expires rows without a registry entry is unbounded growth
 *
 * Postgres reaps nothing on its own, so adding a table whose rows are meant to
 * expire and NOT adding it here produces a table that grows forever
 * — with no error, no failing test and no symptom at all until the disk fills.
 * There is nothing to notice, which is why this is a rule and not a habit:
 * adding an expiring table is TWO edits, the table and this registry, and neither
 * is optional. `__tests__/db/expiry.test.ts` is the gate — it pins the registry
 * to an exact table LIST, so a new TTL'd table fails it until it is named.
 *
 * ## Every entry was checked for INTENT, not just replicated
 *
 * A sweep DELETES the row. oxy-api found a TTL rule
 * that had been written meaning "mark expired" and had been destroying
 * subscription history instead, so each of these says what deleting the row
 * actually costs. One of them — `engagement_outbox` — would delete UNPROCESSED
 * work by deadline alone, so the schedule sweeps only its processed rows.
 *
 * ## Coexistence with reads
 *
 * A sweep lags one interval. Mention has no read
 * path that depends on a swept row already being GONE — every consumer either
 * filters on its own deadline (`available_at`, `lease_until`, `calculated_at >=
 * cutoff`) or is a rolling view where an extra old row is stale, never unsafe.
 * That means the sweep is housekeeping everywhere and no table's correctness
 * depends on the job running. Keep it that way: adding a read that relies on
 * absence turns the sweep interval into a correctness window.
 *
 * ## Scheduling
 *
 * `services/ExpirySweepJob.ts` runs {@link SCHEDULED_EXPIRY_SWEEP_TARGETS} on the
 * elected leader (`runtime/schedulers.ts`). It went unscheduled for months after
 * the port (OxyHQ/Mention#1187): `author_follower_snapshots` alone reached 5.4M
 * rows, 1.4 GB with indexes, against a 30-day retention. Each run deletes in
 * bounded batches, so a backlog like that drains over several runs instead of
 * in one statement.
 *
 * `engagement_outbox` is the one registry entry the schedule does NOT sweep by
 * deadline alone — see its entry and {@link sweepProcessedEngagementOutbox}.
 */

import { and, eq, getTableName, sql } from 'drizzle-orm';
import { executeRows, type SqlExecutor } from '@oxy.so/db';
import type { ExpirySweepOptions, ExpirySweepResult, ExpirySweepTarget } from '@oxy.so/db/expiry';
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
import {
  MCP_AUTH_CODE_RETENTION_SECONDS,
  MCP_EFFECT_RECEIPT_RETENTION_SECONDS,
  mcpAuthCodes,
  mcpEffectReceipts,
} from './schema/mcp';
// `MODERATION_*_RETENTION_SECONDS` are deliberately NOT imported: those two
// tables carry a written `expires_at` that the WRITER already computed from the
// retention constant, so the sweep's own retention is 0 (the column IS the
// deadline). Importing them here would imply a second, independent window.
import { moderationEvents, moderationOutbox } from './schema/moderation';
import { engagementOutbox } from './schema/outbox';

/**
 * Every table whose rows expire. A table with an expiry column but no
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
      'Ranking-feedback telemetry, kept for ninety days. ' +
      'The only reader (`evalFeedQuality`) bounds its own `createdAt >= since`.',
  },
  {
    table: mcpAuthCodes,
    column: mcpAuthCodes.expiresAt,
    retentionSeconds: MCP_AUTH_CODE_RETENTION_SECONDS,
    reason:
      'An OAuth authorization code that is spent or past its deadline. Deleting ' +
      'costs nothing a client can observe: the token endpoint checks `expires_at` ' +
      'explicitly and `used_at` makes redemption single-use, so a row the sweep ' +
      'has not reached yet is already inert. This entry is the whole reason the ' +
      'table does not grow forever — Postgres has no TTL index to reap them.',
  },
  {
    table: mcpEffectReceipts,
    column: mcpEffectReceipts.createdAt,
    retentionSeconds: MCP_EFFECT_RECEIPT_RETENTION_SECONDS,
    reason:
      'Contains only hashes and completion status used to reject a retried MCP ' +
      'write. Thirty days covers delayed transport retries while bounding a row ' +
      'per external effect; no domain read or audit history depends on it.',
  },
  {
    table: moderationEvents,
    column: moderationEvents.expiresAt,
    retentionSeconds: 0,
    reason:
      'The row is BOTH the §10.8 dedupe record and the audit trail of what a ' +
      "third party told this deployment to do. §10.9's retry schedule ends at " +
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
      'WARNING — this is the one entry whose deadline covers UNPROCESSED ' +
      'WORK. Swept by deadline alone, a `pending` event whose dispatcher had ' +
      'been stalled for the whole retention window would be destroyed rather ' +
      'than retried, and the like/save it represents would never reach MTN, ' +
      'federation or notifications — with no backlog alert anywhere to catch ' +
      'it first. So the schedule does NOT pass this entry to `sweepExpiredRows`: ' +
      '`sweepProcessedEngagementOutbox` deletes only `processed` rows past the ' +
      'deadline, and anything still pending stays where a human can find it.',
  },
];

/**
 * What the schedule passes to `sweepExpiredRows`: every entry but
 * `engagement_outbox`, whose deadline-only predicate would delete unprocessed
 * work. That table is swept by {@link sweepProcessedEngagementOutbox} instead.
 */
export const SCHEDULED_EXPIRY_SWEEP_TARGETS: readonly ExpirySweepTarget[] =
  EXPIRY_SWEEP_TARGETS.filter((target) => target.table !== engagementOutbox);

/** Same bounds as `@oxy.so/db/expiry`'s defaults, for the same reasons. */
const OUTBOX_SWEEP_BATCH_SIZE = 1000;
const OUTBOX_SWEEP_MAX_BATCHES = 50;

/**
 * Delete `engagement_outbox` rows that are past `expires_at` AND `processed`.
 *
 * Nothing else ever deletes a processed event, so without this the outbox grows
 * by one row per like, save and vote forever. A row still `pending` or
 * `processing` past its deadline is left alone on purpose: it is a stalled
 * dispatcher's backlog, and deleting it would lose the engagement silently.
 *
 * Deleting a processed row is safe: the dispatcher's ordering check only looks
 * for EARLIER UNPROCESSED revisions, and an event id is derived from its
 * relationship and revision, so it is never re-emitted weeks later.
 *
 * Batched through `ctid` exactly like `sweepExpiredRows`; the predicate walks
 * `engagement_outbox_expires_at_idx` and filters status on the heap.
 */
export async function sweepProcessedEngagementOutbox(
  db: SqlExecutor,
  options: ExpirySweepOptions = {},
): Promise<ExpirySweepResult> {
  const batchSize = options.batchSize ?? OUTBOX_SWEEP_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? OUTBOX_SWEEP_MAX_BATCHES;
  const table = getTableName(engagementOutbox);
  const expired = and(
    sql`${engagementOutbox.expiresAt} <= now()`,
    eq(engagementOutbox.status, 'processed'),
  );

  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const rows = await executeRows(
      db,
      sql`
        delete from ${engagementOutbox}
        where ctid in (
          select ctid from ${engagementOutbox} where ${expired} limit ${batchSize}
        )
        returning ctid
      `,
    );
    deleted += rows.length;
    if (rows.length < batchSize) return { table, deleted, truncated: false };
  }
  return { table, deleted, truncated: true };
}
