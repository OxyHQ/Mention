/**
 * Format a duration in seconds as a clock string.
 *
 * Examples:
 * - 7 -> "0:07"
 * - 83 -> "1:23"
 * - 725 -> "12:05"
 * - 3723 -> "1:02:03"
 */

/**
 * Render `totalSec` as `m:ss`, or `h:mm:ss` once it reaches an hour.
 *
 * The value is FLOORED, never rounded up — the same rule `truncateToTenth` in
 * `formatNumber.ts` applies to counts: a 6.9s clip reads "0:06", because a
 * duration that has not reached a second must not be shown as having reached it.
 *
 * Minutes stay unpadded below an hour (`1:23`) and are padded above it
 * (`1:02:03`), so the leading field is always the largest unit that is actually
 * present. Anything that is not a finite, non-negative number renders `0:00`.
 */
export function formatDuration(totalSec: number): string {
  if (typeof totalSec !== 'number' || !Number.isFinite(totalSec) || totalSec < 0) {
    return '0:00';
  }

  const safe = Math.floor(totalSec);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor(safe / 60) % 60;
  const seconds = safe % 60;
  const paddedSeconds = seconds.toString().padStart(2, '0');

  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${paddedSeconds}`
    : `${minutes}:${paddedSeconds}`;
}
