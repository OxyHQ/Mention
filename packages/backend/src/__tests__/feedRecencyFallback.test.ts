import { describe, it, expect, vi } from 'vitest';
import { fetchWithRecencyFallback, FEED_RECENCY_WINDOWS_MS } from '../utils/feedUtils';

/**
 * Unit coverage for {@link fetchWithRecencyFallback} — the recency-window,
 * never-blank engagement fallback used by the anonymous feed and the popular
 * discovery source.
 *
 * Contract:
 *   - the FIRST window that returns >= desiredCount rows wins (no further scans);
 *   - windows widen in order, then a final UNBOUNDED (cutoff = undefined) pass
 *     guarantees a never-blank result;
 *   - the cutoff Date is computed per-call, near `now - window` (never at module
 *     scope).
 */

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

type Runner = (cutoff: Date | undefined) => Promise<number[]>;

describe('fetchWithRecencyFallback', () => {
  it('returns the first (narrowest) window that fills the page and stops', async () => {
    const run = vi.fn<Runner>(async () => [1, 2, 3]); // full page every time
    const result = await fetchWithRecencyFallback(3, run);

    expect(result).toEqual([1, 2, 3]);
    // Filled on the first (7d) window — no widening.
    expect(run).toHaveBeenCalledTimes(1);
    const cutoff = run.mock.calls[0][0];
    expect(cutoff).toBeInstanceOf(Date);
    expect(Math.abs((cutoff as Date).getTime() - (Date.now() - SEVEN_DAYS))).toBeLessThan(5000);
  });

  it('widens to the 30d window when 7d underfills', async () => {
    const run = vi
      .fn<Runner>()
      .mockResolvedValueOnce([1]) // 7d: underfills (needs 3)
      .mockResolvedValueOnce([1, 2, 3]); // 30d: fills
    const result = await fetchWithRecencyFallback(3, run);

    expect(result).toEqual([1, 2, 3]);
    expect(run).toHaveBeenCalledTimes(2);
    const secondCutoff = run.mock.calls[1][0];
    expect(Math.abs((secondCutoff as Date).getTime() - (Date.now() - THIRTY_DAYS))).toBeLessThan(5000);
  });

  it('falls back to an unbounded scan (never-blank) when every window underfills', async () => {
    const run = vi
      .fn<Runner>()
      .mockResolvedValueOnce([]) // 7d
      .mockResolvedValueOnce([1]) // 30d
      .mockResolvedValueOnce([1, 2]); // unbounded — returned regardless of size
    const result = await fetchWithRecencyFallback(3, run);

    expect(result).toEqual([1, 2]);
    expect(run).toHaveBeenCalledTimes(FEED_RECENCY_WINDOWS_MS.length + 1);
    // The final pass is unbounded (no cutoff).
    expect(run.mock.calls[run.mock.calls.length - 1][0]).toBeUndefined();
  });

  it('exposes the windows narrowest → widest', () => {
    expect(FEED_RECENCY_WINDOWS_MS).toEqual([SEVEN_DAYS, THIRTY_DAYS]);
  });
});
