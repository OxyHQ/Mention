import {
  deleteAdminScriptCursor,
  findAdminScriptCursor,
  upsertAdminScriptCursor,
  type AdminScriptCursorState,
  type AdminScriptCursorUpdate,
} from '../../db/adminScripts/adminScriptStateRepository';
import { describeDriverError } from '@oxyhq/db';
import { logger } from '../../utils/logger';

export type { AdminScriptCursorState, AdminScriptCursorUpdate };

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
  return findAdminScriptCursor(script, scope);
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
    await upsertAdminScriptCursor(script, scope, update);
    return true;
  } catch (error) {
    // Only the driver error's STRUCTURE. The raw error carries the statement and
    // its bound parameters, which include the cursor — and the logger's 24-hex
    // redaction does not cover a uuid v7. The scope is on the returned summary.
    logger.warn('[adminScript] could not persist the resume cursor', {
      script,
      ...describeDriverError(error),
    });
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
  await deleteAdminScriptCursor(script, scope);
}
