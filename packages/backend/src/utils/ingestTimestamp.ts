/**
 * Ingest timestamp guard — the SINGLE rule for accepting a creation date that
 * something OUTSIDE this server asserted.
 *
 * Every ingest path stores a post's ORIGINAL creation date so it sorts by when it
 * was authored rather than when we happened to import it. That date is supplied by
 * the source, and the profile feed and post search both sort on `{createdAt: -1,
 * _id: -1}` — so a timestamp in the future pins that post above everything else for
 * as long as the clock takes to catch up. It has to be bounded at the boundary.
 *
 * REJECT, never rewrite: an out-of-range or unparseable value yields `undefined` so
 * the caller falls back to its own default (the schema's `now`), rather than being
 * silently re-dated to the clamp edge — a post pinned at exactly `now + window` is
 * the same bug with a smaller number. The tolerance is a per-protocol policy
 * decision, so each caller passes its own window rather than sharing one constant.
 */

/**
 * Parse an externally-asserted ISO 8601 creation date, rejecting anything we cannot
 * trust as a creation time.
 *
 * @param value The raw value from the source (AP `published`, an atproto record's
 *   `createdAt`, an MTN record's `createdAt`). Non-strings are rejected outright.
 * @param maxFutureSkewMs How far ahead of our clock the value may legitimately be.
 *   A small skew between independent servers is normal; beyond this the value is
 *   treated as bogus.
 * @returns The parsed `Date`, or `undefined` when the value is missing, blank,
 *   unparseable, or implausibly far in the future.
 */
export function clampFutureDate(value: unknown, maxFutureSkewMs: number): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const parsed = new Date(trimmed);
  const ms = parsed.getTime();
  if (Number.isNaN(ms)) return undefined;

  if (ms > Date.now() + maxFutureSkewMs) return undefined;

  return parsed;
}
