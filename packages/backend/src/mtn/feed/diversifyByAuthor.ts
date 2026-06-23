/**
 * Author-Diversity Rerank
 *
 * Shared greedy reranker that breaks up same-author clustering in ranked feeds.
 *
 * Background: the feed ranking pipeline applies a SOFT multiplicative
 * `sameAuthorPenalty` (0.85^n) per repeated author, but a high-scoring prolific
 * author easily overpowers it — producing the "2 users, then 5 posts in a row
 * from one user" clustering. This reranker enforces the HARD constraints the soft
 * penalty cannot: a minimum gap between two items by the same author and a cap on
 * how many items one author may contribute to a page.
 *
 * It is intentionally generic over the item type so it can space either raw
 * ranked posts (keyed by `oxyUserId`) or post SLICES (keyed by the slice's
 * primary author). Reranking slices keeps multi-post threads intact: a thread is
 * a single slice / single unit, so the reranker only spaces DIFFERENT slices by
 * the same author and never splits a conversation.
 *
 * Properties:
 *  - Never DROPS an item. Overflow / still-conflicting items are appended at the
 *    tail in their original (rank) order, so they still emit (and roll forward
 *    via pagination) rather than being lost.
 *  - Preserves overall rank order as closely as the constraints allow: items are
 *    emitted greedily in rank order, an item is only deferred when emitting it
 *    now would violate the gap or the per-author cap.
 *  - Items with no resolvable author key are treated as conflict-free (they never
 *    block and are never gap-limited), since there is no author to cluster.
 */

import { MtnConfig } from '@mention/shared-types';

export interface DiversifyByAuthorOptions {
  /**
   * Minimum number of OTHER items between two items by the same author.
   * 1 = no two consecutive same-author items. Defaults to the shared config.
   */
  minGap?: number;
  /**
   * Max items a single author may contribute to the page. Overflow items are
   * deferred to the tail (never dropped). Defaults to the shared config.
   */
  maxPerAuthor?: number;
}

/**
 * Greedily reorder `items` so same-author items are spaced by at least
 * `minGap` positions and no author exceeds `maxPerAuthor` items in the page.
 *
 * Algorithm: at each output position pick the highest-RANK remaining item whose
 * author currently satisfies the gap and is under the cap. If no item satisfies
 * the gap (the page is down to authors who all appeared too recently), fall back
 * to the highest-rank uncapped item so the page never stalls — this is the
 * starvation guard. Per-author-cap overflow is held back and appended at the
 * tail in rank order (never dropped). Because we always prefer the highest-rank
 * eligible item, overall rank order is preserved as closely as the spacing and
 * cap constraints allow.
 *
 * @param items   Rank-ordered items (highest priority first).
 * @param authorKeyOf  Extracts the author key for an item; return `undefined`
 *                     for items with no author (treated as conflict-free).
 */
export function diversifyByAuthor<T>(
  items: T[],
  authorKeyOf: (item: T) => string | undefined,
  options: DiversifyByAuthorOptions = {},
): T[] {
  const minGap = options.minGap ?? MtnConfig.ranking.diversity.authorMinGap;
  const maxPerAuthor = options.maxPerAuthor ?? MtnConfig.ranking.diversity.maxPerAuthorPerPage;

  // Nothing to space when there are 0/1 items or the constraints are no-ops.
  if (items.length <= 1 || (minGap <= 0 && maxPerAuthor <= 0)) {
    return items;
  }

  // Remaining items in rank order (index 0 = highest rank). We splice out the
  // chosen item each round, so the array stays rank-ordered.
  const remaining = items.slice();
  const result: T[] = [];
  // Items held back because their author already hit the per-author cap; emitted
  // last, in rank order.
  const overflow: T[] = [];
  // Position (index into `result`) of the most recent emission per author.
  const lastEmittedAt = new Map<string, number>();
  // Count of emitted items per author (in-body emissions only; overflow appended
  // at the tail is bookkept separately so the cap bounds the SPACED run).
  const emittedCount = new Map<string, number>();

  const gapSatisfied = (author: string | undefined): boolean => {
    if (!author) return true; // no author → never clusters
    const last = lastEmittedAt.get(author);
    if (last === undefined) return true;
    // `minGap` OTHER items required between two same-author items → the next
    // legal slot is `last + minGap + 1`, i.e. `result.length - last > minGap`.
    return result.length - last > minGap;
  };

  const capReached = (author: string | undefined): boolean => {
    if (!author || maxPerAuthor <= 0) return false;
    return (emittedCount.get(author) ?? 0) >= maxPerAuthor;
  };

  const emitAt = (index: number): void => {
    const [item] = remaining.splice(index, 1);
    const author = authorKeyOf(item);
    if (author) {
      lastEmittedAt.set(author, result.length);
      emittedCount.set(author, (emittedCount.get(author) ?? 0) + 1);
    }
    result.push(item);
  };

  while (remaining.length > 0) {
    // First, peel off any leading items whose author is over the cap so they
    // don't block — they go to the overflow tail (in rank order).
    let movedToOverflow = false;
    for (let i = 0; i < remaining.length; i += 1) {
      if (capReached(authorKeyOf(remaining[i]))) {
        overflow.push(remaining.splice(i, 1)[0]);
        movedToOverflow = true;
        break;
      }
    }
    if (movedToOverflow) continue;
    if (remaining.length === 0) break;

    // Pick the highest-rank remaining item whose author satisfies the gap.
    let chosen = -1;
    for (let i = 0; i < remaining.length; i += 1) {
      if (gapSatisfied(authorKeyOf(remaining[i]))) {
        chosen = i;
        break;
      }
    }

    // Starvation guard: no item satisfies the strict gap (the page is down to
    // authors that all appeared too recently — there simply aren't enough other
    // authors to fully space them). Rather than blindly taking the top item
    // (which would re-cluster the dominating author), pick the item whose author
    // appeared LEAST recently, breaking ties by rank. This minimizes run length
    // when perfect spacing is mathematically impossible.
    if (chosen === -1) {
      let oldestDistance = -1;
      for (let i = 0; i < remaining.length; i += 1) {
        const author = authorKeyOf(remaining[i]);
        // Authorless items never cluster — emit immediately if present.
        if (!author) {
          chosen = i;
          break;
        }
        const last = lastEmittedAt.get(author);
        const distance = last === undefined ? Number.MAX_SAFE_INTEGER : result.length - last;
        if (distance > oldestDistance) {
          oldestDistance = distance;
          chosen = i;
        }
      }
      if (chosen === -1) chosen = 0;
    }

    emitAt(chosen);
  }

  // Per-author-cap overflow goes last, in rank order.
  for (const item of overflow) {
    result.push(item);
  }

  return result;
}
