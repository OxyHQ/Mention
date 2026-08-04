import { recordRepairFetchFailures as persistRepairFetchFailures } from '../../db/adminScripts/adminScriptStateRepository';
import { describeDriverError } from '../../db/pgErrors';
import { logger } from '../../utils/logger';

/** One failed re-fetch, reduced to what a targeted retry actually needs. */
export interface RepairFetchFailureRecord {
  /** The `Post._id`, as a hex string. */
  postId: string;
  /** How the re-fetch failed — the field a retry selects on. */
  reason: string;
  /** The HTTP status, when the transport got far enough to see one. */
  status?: number;
}

/**
 * Record this page's failed re-fetches, so the transient tail can be retried
 * later without re-walking the whole corpus.
 *
 * Upserted on `(script, postId)`: the collection stays bounded by the number of
 * distinct failing posts however many times a sweep runs, and a post that fails
 * again refreshes its reason and timestamp rather than accumulating a history
 * nothing reads.
 *
 * Returns whether the write landed instead of throwing, for the same reason the
 * cursor write does: a transient database blip must not kill a sweep that is
 * otherwise repairing posts correctly. The caller counts every miss and hands
 * the total to `assertAdminRunComplete`, so silently losing the targeting data
 * still fails the run.
 */
export async function recordRepairFetchFailures(
  script: string,
  failures: readonly RepairFetchFailureRecord[],
): Promise<boolean> {
  if (failures.length === 0) return true;
  const failedAt = new Date();
  try {
    // Explicit field list — never a spread of a caller's object. `status` is
    // passed through as-is, including when it is absent: a defaulted value would
    // move a row from "do not come back" (403/410) into "retry politely"
    // (429/5xx), and a targeted retry would then hammer an origin that refused.
    await persistRepairFetchFailures(
      script,
      failures.map((failure) => ({
        postId: failure.postId,
        reason: failure.reason,
        status: failure.status,
        failedAt,
      })),
    );
    return true;
  } catch (error) {
    // Only the driver error's STRUCTURE. The raw error carries the statement and
    // every bound parameter, post ids included, and the logger's 24-hex
    // redaction does not cover a uuid v7. The count is enough to see that
    // something is wrong.
    logger.warn('[adminScript] could not record re-fetch failures', {
      script,
      count: failures.length,
      ...describeDriverError(error),
    });
    return false;
  }
}
