import { AdminScriptCursor } from '../../models/AdminScriptCursor';
import { logger } from '../../utils/logger';

/** A scope's recorded progress, as the sweep left it. */
export interface AdminScriptCursorState {
  /** The `_id` of the last document the scope scanned, as a hex string. */
  cursor: string;
  /** Documents this scope has scanned in total, accumulated across resumes. */
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

/** The stored fields a read needs; the rest of the document is bookkeeping. */
type AdminScriptCursorRow = Pick<AdminScriptCursorState, 'cursor' | 'scanned'> & {
  completedAt?: Date | null;
};

/**
 * Read where a scope got to, or `null` if it has never run.
 *
 * Deliberately NOT wrapped in a try/catch: a sweep that cannot read its own
 * cursor must not silently start over from the beginning, which is the exact
 * failure this mechanism exists to prevent.
 */
export async function readAdminScriptCursor(
  script: string,
  scope: string,
): Promise<AdminScriptCursorState | null> {
  const stored = await AdminScriptCursor.findOne(
    { script, scope },
    { cursor: 1, scanned: 1, completedAt: 1 },
  ).lean<AdminScriptCursorRow | null>();
  if (!stored) return null;
  return {
    cursor: stored.cursor,
    scanned: stored.scanned,
    completedAt: stored.completedAt ?? null,
  };
}

/**
 * Record where a scope has got to. Called after EVERY page, because the case
 * that most needs a resume point is a run that DIES mid-sweep and never reaches
 * its final summary.
 *
 * Returns whether the write landed instead of throwing: a transient database
 * blip must not kill a sweep that is otherwise repairing documents correctly.
 * It is NOT swallowed, though — the caller counts every miss and hands the total
 * to `assertAdminRunComplete` as a strict issue, so a run whose cursor never
 * persisted exits non-zero rather than quietly becoming unresumable again.
 */
export async function recordAdminScriptCursor(
  script: string,
  scope: string,
  update: AdminScriptCursorUpdate,
): Promise<boolean> {
  try {
    await AdminScriptCursor.updateOne(
      { script, scope },
      {
        $set: {
          cursor: update.cursor,
          scanned: update.scanned,
          completedAt: update.completed ? new Date() : null,
        },
      },
      { upsert: true },
    );
    return true;
  } catch (error) {
    // The cursor itself cannot go in this record — the logger redacts a 24-hex
    // ObjectId under every key. The scope is on the returned summary.
    logger.warn('[adminScript] could not persist the resume cursor', { script, error });
    return false;
  }
}

/**
 * Forget a scope's progress so the next run starts at its declared bound.
 *
 * Throws on failure, unlike a write: this only ever runs because an operator
 * explicitly asked for a fresh start, and honouring that instruction is the
 * whole point. Resuming anyway after a failed clear would be a silent lie.
 */
export async function clearAdminScriptCursor(script: string, scope: string): Promise<void> {
  await AdminScriptCursor.deleteOne({ script, scope });
}
