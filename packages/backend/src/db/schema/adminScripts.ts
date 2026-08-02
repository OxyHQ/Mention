/**
 * Resume state for the one-shot administrative sweeps: `admin_script_cursors`
 * and `repair_fetch_failures`.
 *
 * ## Both are ported because their ABSENCE is an instruction
 *
 * The question worth asking of state like this is not what it is for, but what
 * an operator DOES when it is missing.
 *
 * `admin_script_cursors.completed_at` is not resume state — it is the record
 * that a DESTRUCTIVE sweep ran to exhaustion (`purgeBlockedDomainContent`,
 * `purgeBlockedDomainPlatformData`, `repairFederatedMentions` are its three
 * callers). Lose the row and "already purged" becomes indistinguishable from
 * "never ran", and the recovery a reasonable operator reaches for at that point
 * is re-running a destructive sweep. Four documents against an unbounded
 * failure.
 *
 * `repair_fetch_failures` is the measured version of the same argument. The
 * repair sweep left 46,291 candidates of which only 5,691 were transient
 * failures; without these rows a targeted retry costs ~40,600 requests to other
 * people's servers that cannot produce a repair, so the honest answer becomes
 * "do not retry at all". Losing the collection does not lose a cache — it
 * retires the only affordable path to fixing the tail.
 *
 * ## A cursor is a `_id` STRING, and that is what makes it portable
 *
 * `admin_script_cursors.cursor` holds a hex `_id` rather than an offset, and
 * ids are preserved VERBATIM by this migration, so the value keeps meaning the
 * same row after the cutover. Had it been a Mongo-specific position (a natural
 * order, a `$natural` skip) the ROW would have had to be excluded even though
 * the TABLE was required — the shape where not-copying is the more correct
 * answer. It is not that shape, so it copies.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from './columns';

/**
 * `admin_script_cursors` — where a long-running sweep got to, per shard.
 *
 * A sweep may be split into parallel shards each owning a half-open `_id`
 * range; `scope` is the shard's declared territory, so shards record progress
 * independently and re-running one shard's command resumes THAT shard.
 */
export const adminScriptCursors = pgTable(
  'admin_script_cursors',
  {
    id: generatedId(),
    /** The script's own name — the same token its mutation guard confirms. */
    script: text().notNull(),
    /** The shard's declared territory, canonical and deterministic per shard. */
    scope: text().notNull(),
    /**
     * The `_id` of the last document the scope scanned, as a hex string.
     *
     * A row id rather than an offset, which is why it survives the cutover: ids
     * are copied verbatim, so this keeps pointing at the same row.
     */
    cursor: text().notNull(),
    /** Documents this scope has scanned in total, accumulated across resumes. */
    scanned: integer().notNull().default(0),
    /**
     * Set when the scope's range was walked to exhaustion.
     *
     * The load-bearing column: it is what distinguishes a FINISHED sweep from
     * one that stopped on a limit or died mid-page. NULL means "not known to
     * have finished", never "finished".
     */
    completedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('admin_script_cursors_scanned_check', sql`${t.scanned} >= 0`),
    uniqueIndex('admin_script_cursors_script_scope_key').on(t.script, t.scope),
  ]
);

/**
 * `repair_fetch_failures` — one post whose source re-fetch failed, so the tail
 * can be retried WITHOUT re-walking the corpus.
 *
 * A row is evidence that a fetch failed AT `failed_at`, not that the post is
 * still broken: a later run or the live outbox self-heal may have repaired it.
 * Consumers intersect these ids with the sweep's live candidate filter rather
 * than trusting them alone, which is also what keeps a stale row costing
 * nothing beyond being skipped.
 *
 * `reason` carries NO CHECK deliberately. The vocabulary
 * (`timeout`/`transport`/`httpStatus`/`nonObjectPayload`/`malformedJson`) is
 * the sweep's own and splits into a retryable set and a mapping-failure set;
 * pinning it here would make adding a failure mode a migration, and would refuse
 * rows recording a mode a newer sweep learned to distinguish.
 */
export const repairFetchFailures = pgTable(
  'repair_fetch_failures',
  {
    id: generatedId(),
    /** The sweep that saw the failure — the same token its cursor is keyed on. */
    script: text().notNull(),
    /** The `posts.id` whose source could not be re-fetched. No foreign key. */
    postId: text().notNull(),
    /** How the re-fetch failed. Open vocabulary — see the docblock. */
    reason: text().notNull(),
    /**
     * The HTTP status, when the transport got far enough to see one. NULLABLE
     * and meaningful as NULL: it is what separates "retry politely" (429, 5xx)
     * from "do not come back" (403, 401) inside the single `httpStatus` reason,
     * and a timeout never had one to record.
     */
    status: integer(),
    failedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // A real HTTP status when present. Deliberately wide: a remote server may
    // answer anything, and refusing an unusual-but-real status would drop the
    // evidence of it.
    check(
      'repair_fetch_failures_status_check',
      sql`${t.status} is null or (${t.status} >= 100 and ${t.status} <= 599)`
    ),
    // Bounded by the number of DISTINCT failing posts however many times a
    // sweep runs: a post that fails again refreshes its reason and timestamp.
    uniqueIndex('repair_fetch_failures_script_post_id_key').on(t.script, t.postId),
    // The targeting query this collection exists to serve: "every post this
    // sweep failed to fetch for a retryable reason". Without it that read is a
    // scan.
    index('repair_fetch_failures_script_reason_idx').on(t.script, t.reason),
  ]
);
