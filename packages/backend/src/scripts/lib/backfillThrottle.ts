/**
 * The guard a corpus backfill calls once per batch, so a one-shot run cannot add
 * its load to a database that is already at its limit.
 *
 * WHY. The shared production instance (`oxy-postgres`) has sat at its 6,000-IOPS
 * ceiling with its EBS IO burst balance at 0 since 2026-11-24. A corpus backfill
 * is IO-bound (`backfillRepostValues` took about 20 s per batch of 2000 on a cold
 * `posts`), and the repost run had to be stopped by hand on 2026-11-27 when the
 * burst balance fell. Two rules here keep that from needing a person:
 *
 *  1. OFF-PEAK WINDOW. Batches run only inside a UTC window, by default
 *     01:00-07:00: over 14 days the instance's load is lowest 02:00-13:00 UTC and
 *     Mention's request volume lowest 22:00-04:00 UTC. Outside it the run sleeps
 *     until it opens, and a run that spans days stops again when it closes.
 *     `BACKFILL_WINDOW_UTC=HH-HH` moves it (it may wrap midnight, `22-04`);
 *     `BACKFILL_WINDOW_UTC=always` turns it off, and says so loudly.
 *  2. LATENCY BACKPRESSURE. Each batch is timed. The median of the first few
 *     batches is the run's baseline, and a batch slower than `BACKFILL_SLOW_FACTOR`
 *     times it (default 2), or than `BACKFILL_SLOW_BATCH_MS` (default 60 s), is
 *     slow: the run backs off exponentially (15 s, doubling, capped at
 *     `BACKFILL_BACKOFF_MAX_MS`, default 5 min) and returns to its normal pace once
 *     a batch is fast again. After `BACKFILL_MAX_SLOW_BATCHES` (default 10) slow
 *     batches in a row it stops with {@link BackfillStoppedError}, recording where
 *     it got to, so a run never grinds the database for hours.
 *
 * ONE CALL PER BATCH: `await throttle.beforeBatch({ cursor })` at the top of the
 * loop. The time between two calls is the batch it measures, so a loop's
 * `break`/`continue` needs nothing else. The clock and the sleep are injected,
 * so the rules are tested without waiting.
 *
 * In-process callers (the suites) get {@link fixedPauseThrottle}, the plain pause
 * every script had before; the CLI entry point of each script builds the real
 * guard from its environment with {@link createBackfillThrottle}.
 */

import { logger } from '../../utils/logger';
import { sleep as realSleep } from '../../utils/sleep';
import { recordAdminScriptCursor } from './adminScriptCursor';

export const BACKFILL_WINDOW_ENV = 'BACKFILL_WINDOW_UTC';
export const DEFAULT_BACKFILL_WINDOW = '01-07';

/** The exit code of a run the guard stopped: work is left, re-run it later. Not a crash. */
export const EXIT_BACKFILL_STOPPED = 75;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A batch is never slow under this, whatever the baseline: jitter on a fast batch is not load. */
const MIN_SLOW_MS = 1_000;

/** Hours of the UTC day in which batches may run: `[startHour, endHour)`, wrapping midnight when start > end. */
export type BackfillWindow =
  | { readonly always: true }
  | { readonly always: false; readonly startHour: number; readonly endHour: number };

/** Parse `BACKFILL_WINDOW_UTC`: `HH-HH` (end may be 24, may wrap) or `always`. Unset is the default window. */
export function parseBackfillWindow(raw: string | undefined): BackfillWindow {
  const value = (raw ?? '').trim().toLowerCase() || DEFAULT_BACKFILL_WINDOW;
  if (value === 'always') return { always: true };
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(value);
  const startHour = match ? Number(match[1]) : Number.NaN;
  const endHour = match ? Number(match[2]) : Number.NaN;
  if (!match || startHour > 23 || endHour > 24 || startHour === endHour) {
    throw new Error(
      `${BACKFILL_WINDOW_ENV}=${raw} is not a window: use HH-HH in UTC (e.g. 01-07, 22-04) or "always"`,
    );
  }
  return { always: false, startHour, endHour };
}

function formatWindow(window: BackfillWindow): string {
  if (window.always) return 'always';
  const pad = (hour: number) => String(hour).padStart(2, '0');
  return `${pad(window.startHour)}-${pad(window.endHour)}`;
}

/** Is `nowMs` inside the window? */
export function isInsideBackfillWindow(window: BackfillWindow, nowMs: number): boolean {
  if (window.always) return true;
  const hour = new Date(nowMs).getUTCHours();
  return window.startHour < window.endHour
    ? hour >= window.startHour && hour < window.endHour
    : hour >= window.startHour || hour < window.endHour;
}

/** Milliseconds until the window next opens; 0 when it is open now. */
export function msUntilBackfillWindowOpens(window: BackfillWindow, nowMs: number): number {
  if (window.always || isInsideBackfillWindow(window, nowMs)) return 0;
  const dayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const todayOpen = dayStart + window.startHour * HOUR_MS;
  return (todayOpen > nowMs ? todayOpen : todayOpen + DAY_MS) - nowMs;
}

export interface BackfillThrottleConfig {
  window: BackfillWindow;
  /** The normal rest between batches. */
  pauseMs: number;
  /**
   * Time the batches and back off when they slow down. Off only for a script that
   * already paces itself against the database's load (`backfillPostLanguages`), whose
   * own sleeps would read as slow batches.
   */
  backpressure: boolean;
  /** Batches whose median is the baseline. */
  baselineBatches: number;
  /** A batch slower than this multiple of the baseline is slow. */
  slowFactor: number;
  /** A batch slower than this is slow whatever the baseline; 0 disables the ceiling. */
  slowCeilingMs: number;
  /** The first backoff; each slow batch in a row doubles it. */
  backoffBaseMs: number;
  /** The longest backoff. */
  backoffMaxMs: number;
  /** Stop after this many slow batches in a row. */
  maxConsecutiveSlow: number;
}

export const DEFAULT_BACKFILL_THROTTLE: Omit<BackfillThrottleConfig, 'window' | 'pauseMs'> = {
  backpressure: true,
  baselineBatches: 5,
  slowFactor: 2,
  slowCeilingMs: 60_000,
  backoffBaseMs: 15_000,
  backoffMaxMs: 5 * 60_000,
  maxConsecutiveSlow: 10,
};

type Environment = Readonly<Record<string, string | undefined>>;

function envNumber(env: Environment, key: string, min: number): number | undefined {
  const raw = env[key]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${key}=${raw} must be a number >= ${min}`);
  }
  return value;
}

/** The guard's settings from the environment, over the defaults. Throws on a malformed value, before any batch runs. */
export function backfillThrottleConfigFromEnv(
  env: Environment,
  pauseMs: number,
): BackfillThrottleConfig {
  const d = DEFAULT_BACKFILL_THROTTLE;
  return {
    window: parseBackfillWindow(env[BACKFILL_WINDOW_ENV]),
    pauseMs,
    backpressure: d.backpressure,
    baselineBatches: d.baselineBatches,
    slowFactor: envNumber(env, 'BACKFILL_SLOW_FACTOR', 1) ?? d.slowFactor,
    slowCeilingMs: envNumber(env, 'BACKFILL_SLOW_BATCH_MS', 0) ?? d.slowCeilingMs,
    backoffBaseMs: d.backoffBaseMs,
    backoffMaxMs: envNumber(env, 'BACKFILL_BACKOFF_MAX_MS', 0) ?? d.backoffMaxMs,
    maxConsecutiveSlow: Math.floor(
      envNumber(env, 'BACKFILL_MAX_SLOW_BATCHES', 1) ?? d.maxConsecutiveSlow,
    ),
  };
}

/** The guard stopped the run because the database stayed slow. Work is left; the cursor is where to resume. */
export class BackfillStoppedError extends Error {
  readonly exitCode = EXIT_BACKFILL_STOPPED;
  constructor(
    readonly script: string,
    readonly cursor: string | null,
  ) {
    super(`[${script}] stopped by the backfill throttle: the database stayed slow`);
    this.name = 'BackfillStoppedError';
  }
}

/** The exit code for a script's failure: {@link EXIT_BACKFILL_STOPPED} when the guard stopped it, 1 otherwise. */
export function backfillExitCode(error: unknown): number {
  return error instanceof BackfillStoppedError ? error.exitCode : 1;
}

/** Where the loop has got to: the last key it finished, and which walk that key belongs to. */
export interface BackfillProgress {
  cursor?: string | null;
  /** The walk, when a script has several (a table, a shard). */
  scope?: string;
  /** Rows done so far in this scope. */
  scanned?: number;
}

export interface BackfillThrottle {
  /** Call at the top of every batch: waits for the window and paces after the previous batch. */
  beforeBatch(progress?: BackfillProgress): Promise<void>;
}

/** The plain pause between batches, no window and no backpressure: in-process callers and the suites. */
export function fixedPauseThrottle(
  pauseMs: number,
  sleep: (ms: number) => Promise<void> = realSleep,
): BackfillThrottle {
  let started = false;
  return {
    async beforeBatch() {
      if (started && pauseMs > 0) await sleep(pauseMs);
      started = true;
    },
  };
}

export interface CreateBackfillThrottleOptions {
  script: string;
  /** The script's normal rest between batches. */
  pauseMs: number;
  /** Read for the window and the thresholds; `process.env` by default. */
  env?: Environment;
  /** Overrides on top of what the environment says (tests). */
  config?: Partial<BackfillThrottleConfig>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Record where a stopped run got to. By default `admin_script_cursors` under
   * scope `throttle-stop:<scope>`: the log redacts ids, so the log alone cannot
   * carry a resumable uuid cursor.
   */
  recordStop?: (scope: string, cursor: string, scanned: number) => Promise<boolean>;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The guard: the off-peak window and latency backpressure, from the environment. */
export function createBackfillThrottle(opts: CreateBackfillThrottleOptions): BackfillThrottle {
  const config: BackfillThrottleConfig = {
    ...backfillThrottleConfigFromEnv(opts.env ?? process.env, opts.pauseMs),
    ...opts.config,
  };
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const script = opts.script;
  const recordStop =
    opts.recordStop ??
    ((scope: string, cursor: string, scanned: number) =>
      recordAdminScriptCursor(script, `throttle-stop:${scope}`, { cursor, scanned }));
  const window = formatWindow(config.window);

  if (config.window.always) {
    logger.warn('[backfillThrottle] OFF-PEAK WINDOW DISABLED: batches run at any hour', {
      script,
      env: `${BACKFILL_WINDOW_ENV}=always`,
    });
  } else {
    logger.info('[backfillThrottle] batches run only inside the UTC window', { script, window });
  }

  let lastStartedAt: number | null = null;
  let samples: number[] = [];
  let baselineMs: number | null = null;
  let consecutiveSlow = 0;

  const thresholdMs = (): number => {
    const byBaseline =
      baselineMs === null ? Number.POSITIVE_INFINITY : config.slowFactor * baselineMs;
    const byCeiling = config.slowCeilingMs > 0 ? config.slowCeilingMs : Number.POSITIVE_INFINITY;
    return Math.max(MIN_SLOW_MS, Math.min(byBaseline, byCeiling));
  };

  const paceAfter = async (durationMs: number, progress: BackfillProgress): Promise<void> => {
    if (!config.backpressure) {
      if (config.pauseMs > 0) await sleep(config.pauseMs);
      return;
    }
    const threshold = thresholdMs();
    const slow = durationMs > threshold;
    if (baselineMs === null && !slow) {
      samples.push(durationMs);
      if (samples.length >= config.baselineBatches) {
        baselineMs = median(samples);
        logger.info('[backfillThrottle] baseline measured', {
          script,
          baselineMs,
          slowAboveMs: thresholdMs(),
        });
      }
    }

    if (!slow) {
      if (consecutiveSlow > 0) {
        logger.info('[backfillThrottle] batches fast again; normal pace', {
          script,
          durationMs,
          slowBatches: consecutiveSlow,
        });
      }
      consecutiveSlow = 0;
      if (config.pauseMs > 0) await sleep(config.pauseMs);
      return;
    }

    consecutiveSlow += 1;
    const scope = progress.scope ?? 'default';
    if (consecutiveSlow >= config.maxConsecutiveSlow) {
      const cursor = progress.cursor ?? null;
      const recorded = cursor ? await recordStop(scope, cursor, progress.scanned ?? 0) : false;
      logger.error('[backfillThrottle] stopping: the database stayed slow', {
        script,
        scope,
        slowBatches: consecutiveSlow,
        durationMs,
        slowAboveMs: threshold,
        // The log redacts uuids; the cursor is recorded in admin_script_cursors.
        cursor,
        cursorRecordedAs: recorded ? `admin_script_cursors ${script} throttle-stop:${scope}` : null,
      });
      throw new BackfillStoppedError(script, cursor);
    }
    const backoffMs = Math.min(
      config.backoffBaseMs * 2 ** (consecutiveSlow - 1),
      config.backoffMaxMs,
    );
    logger.warn('[backfillThrottle] slow batch; backing off', {
      script,
      scope,
      durationMs,
      slowAboveMs: threshold,
      slowBatches: consecutiveSlow,
      backoffMs,
    });
    await sleep(Math.max(config.pauseMs, backoffMs));
  };

  const waitForWindow = async (): Promise<void> => {
    let waited = false;
    for (;;) {
      const waitMs = msUntilBackfillWindowOpens(config.window, now());
      if (waitMs <= 0) break;
      if (!waited) {
        logger.info('[backfillThrottle] outside the off-peak window; waiting', {
          script,
          window,
          opensAt: new Date(now() + waitMs).toISOString(),
          waitMs,
        });
        waited = true;
      }
      await sleep(waitMs);
    }
    if (waited) {
      // A cache that went cold while we slept is not the database being busy:
      // measure the baseline again.
      samples = [];
      baselineMs = null;
      consecutiveSlow = 0;
      logger.info('[backfillThrottle] window open; resuming', { script, window });
    }
  };

  return {
    async beforeBatch(progress: BackfillProgress = {}) {
      if (lastStartedAt !== null) await paceAfter(now() - lastStartedAt, progress);
      await waitForWindow();
      lastStartedAt = now();
    },
  };
}
