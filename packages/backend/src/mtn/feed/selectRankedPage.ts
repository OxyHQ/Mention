import { MtnConfig } from '@mention/shared-types';
import { capDiscoveryShare } from './capDiscoveryShare';
import { diversifyByAuthor } from './diversifyByAuthor';

/** Choose membership jointly, then space the chosen page without changing it. */
export function selectRankedPage<T>(
  items: T[],
  authorOf: (item: T) => string | undefined,
  isDiscovery: (item: T) => boolean,
  limit: number,
  maxDiscoveryShare?: number,
  maxConsecutive = 1,
): T[] {
  const counts = new Map<string, number>();
  const eligible: T[] = [];
  const overflow: T[] = [];
  const maxPerAuthor = MtnConfig.ranking.diversity.maxPerAuthorPerPage;
  for (const item of items) {
    const author = authorOf(item);
    const count = author ? (counts.get(author) ?? 0) : 0;
    if (author && maxPerAuthor > 0 && count >= maxPerAuthor) overflow.push(item);
    else {
      eligible.push(item);
      if (author) counts.set(author, count + 1);
    }
  }
  // Concentrated trusted inventory is not enough to satisfy a trusted floor:
  // prefer another discovery author over breaking author diversity to reach it.
  const chosen = capDiscoveryShare(eligible, isDiscovery, maxDiscoveryShare, limit).slice(0, limit);
  if (chosen.length < limit) chosen.push(...overflow.slice(0, limit - chosen.length));
  return diversifyByAuthor(chosen, authorOf, { maxConsecutive });
}
