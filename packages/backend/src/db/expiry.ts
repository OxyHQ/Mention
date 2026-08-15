/**
 * Expiry Sweep registry — the replacement for Mongo TTL indexes
 *
 * Postgres has no TTL index. Several Mention collections relied on one before
 * the port, so every table that needs it adds an entry here rather than growing
 * its own cleanup path. The registry stays here because it names THIS schema's
 * own tables; the mechanism that sweeps it (`sweepExpiredRows`,
 * `sweepAllExpiredRows`, `ExpirySweepTarget`) lives in `@oxyhq/db/expiry` — see
 * that module's doc comment for the full shape and for why a TTL index is a
 * behaviour of the SOURCE that does not survive a Mongo-to-Postgres port on its
 * own.
 *
 * ## THE RULE, because it is the quietest failure in this file's subject
 *
 * **Nothing reaps a Postgres table on its own.** A table added without a
 * registry entry grows FOREVER — no error, no failing test, no symptom of any
 * kind until disk. It is structurally invisible: there is no missing call site
 * and no orphaned function, nothing a reviewer diffing the change would see go
 * absent.
 *
 * That was not hypothetical during the port, where the omissions tracked the
 * porting frontier exactly — measured 2026-08-02, ten collections declared a TTL
 * index, eight had an entry, and the two gaps were precisely the two nobody had
 * ported yet. It stopped being self-correcting once the models were deleted:
 * there is no longer any source declaration a walk could derive this list from.
 *
 * **So the registry is the WHOLE obligation, and `__tests__/db/expiry.test.ts`
 * holds it EXACT in both directions** — a table that lost its entry and a table
 * that never had one fail the same way. Two arrived exactly that way,
 * `mcp_auth_codes` and `trend_graphs`, each ported without an entry until that
 * test said so. Deleting an entry alongside a table's last writer is the obvious
 * tidy-up and is exactly the failure this guards.
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
 * `@oxyhq/db/expiry`'s `sweepExpiredRows` is the mechanism; wiring it to a
 * schedule belongs with the call-site port, alongside the leader-gated jobs
 * already in `services/FeedJobScheduler.ts`. Until then it is callable and
 * tested, and nothing reads a swept table yet.
 */

import type { ExpirySweepTarget } from '@oxyhq/db/expiry';
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
import { MCP_AUTH_CODE_RETENTION_SECONDS, mcpAuthCodes } from './schema/mcp';
// `MODERATION_*_RETENTION_SECONDS` are deliberately NOT imported: those two
// tables carry a written `expires_at` that the WRITER already computed from the
// retention constant, so the sweep's own retention is 0 (the column IS the
// deadline). Importing them here would imply a second, independent window.
import { moderationEvents, moderationOutbox } from './schema/moderation';
import { engagementOutbox } from './schema/outbox';

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
    table: mcpAuthCodes,
    column: mcpAuthCodes.expiresAt,
    retentionSeconds: MCP_AUTH_CODE_RETENTION_SECONDS,
    reason:
      'An OAuth authorization code that is spent or past its deadline. Deleting ' +
      'costs nothing a client can observe: the token endpoint checks `expires_at` ' +
      'explicitly and `used_at` makes redemption single-use, so a row the sweep ' +
      'has not reached yet is already inert. This entry is the whole reason the ' +
      'table does not grow forever — Mongo reaped these with a TTL index, and a ' +
      'TTL is a behaviour of the SOURCE that does not survive the port on its own.',
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
