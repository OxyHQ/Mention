/**
 * `admin_script_cursors` and `repair_fetch_failures` — the resume state and the
 * failure tail of the one-shot administrative sweeps.
 *
 * ## Two columns whose NULL must stay NULL
 *
 * `completed_at` is not resume state: it is the record that a DESTRUCTIVE sweep
 * ran to exhaustion. NULL means NOT KNOWN TO HAVE FINISHED, never "finished".
 * An invented value fails toward SILENCE — a purge quietly never re-run — while
 * a missing one fails toward WORK, a purge re-run. Only the second is
 * recoverable, so the code must not be what chooses.
 *
 * `repair_fetch_failures.status` is the same argument with a measured cost. A
 * default is not erasure here, it is RELOCATION: a defaulted 500 moves the row
 * from "do not come back" (403/410) into "retry politely" (429/5xx), and a
 * targeted retry then hammers an origin that already refused. NULL is what a
 * timeout genuinely has.
 */

import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../postgres';
import { adminScriptCursors, repairFetchFailures } from '../schema/adminScripts';

/** A scope's recorded progress, as the sweep left it. */
export interface AdminScriptCursorState {
  /** The id of the last row the scope scanned. */
  cursor: string;
  /** Rows this scope has scanned in total, accumulated across resumes. */
  scanned: number;
  /** When the scope's range was walked to exhaustion, or `null` if it was not. */
  completedAt: Date | null;
}

/** What a sweep knows about its own progress at the end of a page. */
export interface AdminScriptCursorUpdate {
  cursor: string;
  scanned: number;
  /** The range was walked to exhaustion — stamp the scope as finished. */
  completed?: boolean;
}

/** Where a scope got to, or `null` if it has never run. */
export async function findAdminScriptCursor(
  script: string,
  scope: string
): Promise<AdminScriptCursorState | null> {
  const [row] = await getDb()
    .select({
      cursor: adminScriptCursors.cursor,
      scanned: adminScriptCursors.scanned,
      completedAt: adminScriptCursors.completedAt,
    })
    .from(adminScriptCursors)
    .where(and(eq(adminScriptCursors.script, script), eq(adminScriptCursors.scope, scope)))
    .limit(1);
  return row ?? null;
}

/**
 * Record where a scope has got to.
 *
 * `completed_at` is written on EVERY save — set when the range was exhausted and
 * back to NULL otherwise. That is deliberate and matches the Mongo write: a
 * scope that finished and is then re-run from an earlier point has not finished
 * any more, and leaving the old stamp would say it had.
 */
export async function upsertAdminScriptCursor(
  script: string,
  scope: string,
  update: AdminScriptCursorUpdate
): Promise<void> {
  const completedAt = update.completed ? new Date() : null;
  await getDb()
    .insert(adminScriptCursors)
    .values({ script, scope, cursor: update.cursor, scanned: update.scanned, completedAt })
    .onConflictDoUpdate({
      target: [adminScriptCursors.script, adminScriptCursors.scope],
      set: { cursor: update.cursor, scanned: update.scanned, completedAt, updatedAt: new Date() },
    });
}

/** Forget a scope's progress so the next run starts at its declared bound. */
export async function deleteAdminScriptCursor(script: string, scope: string): Promise<void> {
  await getDb()
    .delete(adminScriptCursors)
    .where(and(eq(adminScriptCursors.script, script), eq(adminScriptCursors.scope, scope)));
}

/** One post whose source re-fetch failed. */
export interface RepairFetchFailureInput {
  postId: string;
  reason: string;
  /**
   * The HTTP status, when the transport got far enough to see one.
   *
   * `undefined` is stored as NULL and MUST NOT be defaulted — see the module
   * docblock. A timeout genuinely has none.
   */
  status?: number;
  failedAt: Date;
}

/**
 * Record this sweep's failures, one row per post.
 *
 * Keyed on `(script, post_id)`, so a post that fails again REFRESHES its reason
 * and timestamp rather than appending — which is what bounds the table by the
 * number of distinct failing posts however many times a sweep runs.
 */
export async function recordRepairFetchFailures(
  script: string,
  failures: readonly RepairFetchFailureInput[]
): Promise<void> {
  if (failures.length === 0) return;
  await getDb()
    .insert(repairFetchFailures)
    .values(
      failures.map((failure) => ({
        script,
        postId: failure.postId,
        reason: failure.reason,
        status: failure.status ?? null,
        failedAt: failure.failedAt,
      }))
    )
    .onConflictDoUpdate({
      target: [repairFetchFailures.script, repairFetchFailures.postId],
      set: {
        reason: sql`excluded.reason`,
        // `excluded.status` and not a coalesce: a post that failed with a 403 and
        // now times out really does have no status, and carrying the old one
        // forward would say the origin refused again when it never answered.
        status: sql`excluded.status`,
        failedAt: sql`excluded.failed_at`,
        updatedAt: new Date(),
      },
    });
}
