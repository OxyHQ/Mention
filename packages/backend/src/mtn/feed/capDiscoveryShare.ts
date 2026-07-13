/**
 * Discovery-Share Cap (Phase 5)
 *
 * Bounds how much of a rendered ranked page may come from DISCOVERY lanes,
 * guaranteeing a floor for TRUSTED (following / affinity / subscribed-lists)
 * content on the For You feed.
 *
 * Background: For You gathers candidates from both TRUSTED lanes (the viewer's own
 * chosen graph) and DISCOVERY lanes (topics / language / region / trending /
 * global). Ranking mixes them by score, so on a noisy federated instance a burst
 * of high-scoring discovery candidates can crowd the page and bury the trusted
 * content the viewer actually opted into. This cap enforces the hard share
 * constraint ranking's soft signals cannot.
 *
 * Contract — IDENTICAL to `diversifyByAuthor`:
 *  - NEVER drops an item. Discovery slices beyond the cap are DEFERRED to the page
 *    tail (in their original rank order), so they still emit (after the trusted
 *    content, or roll forward via pagination) rather than being lost.
 *  - On a THIN follow graph the cap is simply unmet: there isn't enough trusted
 *    content to fill the trusted floor, so the deferred discovery slices backfill
 *    the tail and the page still fills to `limit`. The never-blank + popular
 *    fallback paths upstream are untouched.
 *  - A no-op (returns the input unchanged) when no cap is configured, the share
 *    admits everything, there are no discovery slices, or nothing needs deferring.
 */

/**
 * Reorder `slices` so at most `floor(maxShare · limit)` DISCOVERY slices appear
 * before any deferred overflow, deferring the rest to the tail in rank order.
 *
 * Generic over the slice type with an injectable `isDiscovery` predicate so it can
 * run on raw (pre-hydration) slices in the engine and be unit-tested against plain
 * fixtures. Trusted slices (predicate `false`) always stay in place; only the
 * discovery slices beyond the cap move to the tail — everything else keeps its
 * relative rank order (stable partition).
 *
 * @param slices        Rank-ordered slices (highest priority first).
 * @param isDiscovery   Whether a slice originated from a discovery lane.
 * @param maxShare      Max discovery share (0..1) of the page, or `undefined` for no cap.
 * @param limit         The rendered page size the share is computed against.
 */
export function capDiscoveryShare<T>(
  slices: T[],
  isDiscovery: (slice: T) => boolean,
  maxShare: number | undefined,
  limit: number,
): T[] {
  // No cap configured, an empty/degenerate page, or a share that admits every
  // slice (≥ 1) → nothing to cap.
  if (maxShare === undefined || maxShare >= 1 || slices.length === 0 || limit <= 0) {
    return slices;
  }

  const maxDiscovery = Math.max(0, Math.floor(maxShare * limit));

  const kept: T[] = [];
  const deferred: T[] = [];
  let discoveryKept = 0;
  for (const slice of slices) {
    if (isDiscovery(slice)) {
      if (discoveryKept >= maxDiscovery) {
        deferred.push(slice);
        continue;
      }
      discoveryKept += 1;
    }
    kept.push(slice);
  }

  // Nothing exceeded the cap → return the input unchanged (no reordering).
  if (deferred.length === 0) {
    return slices;
  }

  return [...kept, ...deferred];
}
