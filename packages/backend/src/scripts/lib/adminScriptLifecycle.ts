import { closeQueues } from '../../queue/queues';
import { closeQueueConnection } from '../../queue/connection';
import { closeRedisConnection } from '../../utils/redis';
import { logger } from '../../utils/logger';

/**
 * Close the lazily-created producer resources an administrative script may have
 * opened through federation/media services. Queue handles must close before
 * their shared ioredis connection. Every function is safe when never initialized.
 */
export async function closeAdminScriptResources(): Promise<void> {
  await closeQueues();
  await Promise.all([
    closeQueueConnection(),
    closeRedisConnection(),
  ]);
}

/**
 * A stated allowance for ONE kind of issue: the fraction of scanned items it may
 * reach before the run counts as incomplete.
 *
 * A fraction, never an absolute count, because a sweep's batch size is a run-time
 * choice: "12 failures" means nothing without knowing whether 600 or 165,000
 * items were scanned, and an absolute ceiling tuned on a canary silently becomes
 * either meaningless or unreachable at full scale.
 */
export interface AdminRunTolerance {
  /**
   * Inclusive ceiling on `count / scanned`. `0` (the default for every kind that
   * is not listed) means the issue fails the run at ANY count.
   */
  maxFraction: number;
  /**
   * Why this kind is tolerable at all. REQUIRED so a threshold can never be
   * added without an argument for it sitting next to the number.
   */
  reason: string;
}

export interface AdminRunCompletionOptions {
  /** Denominator for every fraction — the number of items the run actually visited. */
  scanned: number;
  /** Per-issue-kind allowances. Anything absent from this map stays strict. */
  tolerate: Readonly<Record<string, AdminRunTolerance>>;
}

/** One issue kind that was non-zero but stayed within its stated allowance. */
interface ToleratedIssue {
  issue: string;
  count: number;
  rate: number;
  threshold: number;
}

/**
 * Fail an administrative run whose work did not fully resolve, so a partial
 * sweep is never reported as a success.
 *
 * By DEFAULT every non-zero counter fails the run — that is the right rule for a
 * bounded, in-our-control sweep and it is what every caller gets when it passes
 * no options.
 *
 * A sweep over the open fediverse cannot meet that bar: across a hundred
 * thousand remote origins there will ALWAYS be some hosts that are down,
 * rate-limiting, or answering 5xx, so a strict guard makes a full-scale run
 * incapable of ever completing cleanly. The answer is NOT to stop counting those
 * failures or to add an env var that skips the check — both convert a real
 * regression into a green run. It is for the CALLER to state, in code and with
 * its reasoning attached, which kinds tolerate what rate. The threshold is a
 * property of the sweep, not of the invocation, so it is never configurable from
 * the outside.
 *
 * Two things stay separate and must not be conflated:
 *  - the remote world being imperfect (a dead host, a 5xx, a timeout) — expected
 *    at scale, tolerable below a stated rate;
 *  - OUR side failing (a payload we could not parse, a write error, a bug) —
 *    never tolerable, at any count, because the rate is not the point.
 *
 * Whatever the verdict, nothing is hidden: a tolerated-but-non-zero kind is
 * logged as a WARNING naming its count, its rate and the threshold it was
 * measured against, so a sweep degrading from 2% to 30% is obvious in the log
 * even though both runs "pass".
 */
export function assertAdminRunComplete(
  scriptName: string,
  issues: Readonly<Record<string, number>>,
  options?: AdminRunCompletionOptions,
): void {
  const violations: string[] = [];
  const tolerated: ToleratedIssue[] = [];

  for (const [issue, count] of Object.entries(issues)) {
    if (count <= 0) continue;

    const tolerance = options?.tolerate[issue];
    if (!tolerance || tolerance.maxFraction <= 0) {
      violations.push(`${issue}=${count}`);
      continue;
    }

    // A fraction of nothing is undefined, so a non-zero count with nothing
    // scanned can never be "within tolerance" — it fails, loudly.
    const scanned = options?.scanned ?? 0;
    if (scanned <= 0) {
      violations.push(`${issue}=${count} (nothing scanned; no rate to measure)`);
      continue;
    }

    const rate = count / scanned;
    if (rate > tolerance.maxFraction) {
      violations.push(
        `${issue}=${count} (${formatRate(rate)} of ${scanned} scanned, over the ${formatRate(tolerance.maxFraction)} allowed for: ${tolerance.reason})`,
      );
      continue;
    }
    tolerated.push({ issue, count, rate, threshold: tolerance.maxFraction });
  }

  if (tolerated.length > 0) {
    // Counters ride in the structured CONTEXT, never interpolated into the
    // message — see `__tests__/utils/loggerPolicy.test.ts`.
    logger.warn('[adminScript] run completed with tolerated failures', {
      script: scriptName,
      scanned: options?.scanned ?? 0,
      tolerated,
    });
  }

  if (violations.length === 0) return;

  throw new Error(`[${scriptName}] run incomplete: ${violations.join(', ')}`);
}

/** A fraction as a bounded percentage, for a human reading a failure message. */
function formatRate(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}
