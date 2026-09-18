/**
 * One clamp for every paginated listing.
 *
 * ## Why this exists: "absent" must never mean "everything"
 *
 * `GET /feeds` and `GET /lists` used to read an absent `limit` as "return every
 * matching row", then hydrate relations, like counts, owner profiles and member
 * avatars for all of them. The search screen called both with no `limit`, so a
 * one-character query fanned out into two unbounded listings plus their full
 * enrichment — and so did the home tab, which asks for every public custom feed
 * on mount. A response whose size is decided by how much data the database
 * happens to hold is not a page; it is an outage waiting for the table to grow.
 *
 * The clamp itself was also copy-pasted four ways
 * (`Math.min(Math.max(1, raw || DEFAULT), MAX)`, with and without the
 * `Math.max`, so `?limit=0` and `?limit=-5` behaved differently per route). One
 * function means a ceiling raised for one listing cannot silently leave another
 * on the old one — the same argument `postPageBounds.ts` makes for the two
 * numbers it holds, which remain the post lists' own bounds and are passed in
 * here rather than duplicated.
 *
 * This deliberately takes the bounds as ARGUMENTS instead of owning a registry
 * of them: a lane's page size belongs next to the lane, and a second table of
 * numbers here would be a place for them to disagree.
 */

export interface PageLimitBounds {
  /** Used when the caller supplies nothing usable. Never "unbounded". */
  fallback: number;
  /** Hard ceiling. A caller asking for more gets this. */
  max: number;
}

/**
 * Resolve a client-supplied page limit to a bounded positive integer.
 *
 * Accepts the shapes an Express query string actually produces — a string, a
 * number, `undefined`, or an array when the parameter is repeated — and
 * collapses every unusable one (missing, non-numeric, zero, negative,
 * fractional, `Infinity`, `NaN`) to `fallback`. That is the point: there is no
 * input, malformed or hostile, that yields an unbounded query.
 *
 * A repeated parameter (`?limit=5&limit=500`) arrives as an array; the FIRST
 * value wins, because the alternative is letting a caller append a second
 * parameter to escape a limit a middleware set for it.
 */
export function resolvePageLimit(raw: unknown, bounds: PageLimitBounds): number {
  const first = Array.isArray(raw) ? raw[0] : raw;
  const parsed =
    typeof first === 'number'
      ? first
      : typeof first === 'string'
        ? Number.parseInt(first, 10)
        : Number.NaN;

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    return bounds.fallback;
  }
  return Math.min(parsed, bounds.max);
}

/**
 * Resolve a non-negative offset, for the listings that still page by offset.
 *
 * Separate from {@link resolvePageLimit} because the degenerate value differs:
 * an absent limit must become a page size, while an absent offset is genuinely
 * zero. Folding them into one helper would need a sentinel to tell the two
 * apart, which is how "0 means unbounded" bugs get written.
 */
export function resolvePageOffset(raw: unknown): number {
  const first = Array.isArray(raw) ? raw[0] : raw;
  const parsed =
    typeof first === 'number'
      ? first
      : typeof first === 'string'
        ? Number.parseInt(first, 10)
        : Number.NaN;

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}
