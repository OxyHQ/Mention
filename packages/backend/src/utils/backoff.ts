export interface BackoffOptions {
  /** Delay before the first retry (attempt 0), in milliseconds. */
  baseMs: number;
  /** Ceiling for the exponential part, before jitter is added. Unbounded when omitted. */
  maxMs?: number;
  /** Extra random delay as a fraction of the exponential part, in `[0, jitter)`. Default 0.25. */
  jitter?: number;
}

/**
 * Exponential backoff with additive jitter: `baseMs * 2^attempt`, capped at
 * `maxMs`, plus up to `jitter` of itself. `attempt` is zero-based. The jitter is
 * added after the cap, so the result can exceed `maxMs` by up to that fraction;
 * a caller with a hard ceiling clamps the result itself.
 */
export function backoffDelayMs(attempt: number, options: BackoffOptions): number {
  const { baseMs, maxMs = Number.POSITIVE_INFINITY, jitter = 0.25 } = options;
  const exponential = Math.min(baseMs * 2 ** attempt, maxMs);
  return exponential + Math.floor(Math.random() * exponential * jitter);
}
