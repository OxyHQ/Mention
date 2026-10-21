import type { RankingUserBehavior } from './ranking/signalContext';

/** Negative author choices override a bell; this does not alter post access. */
export function eligibleActivitySubscriptionAuthors(
  authorIds: readonly string[] | undefined,
  behavior?: Pick<RankingUserBehavior, 'hiddenAuthors' | 'mutedAuthors' | 'blockedAuthors'>,
  blockedIds: readonly string[] = [],
): string[] {
  const excluded = new Set([
    ...blockedIds,
    ...(behavior?.hiddenAuthors ?? []),
    ...(behavior?.mutedAuthors ?? []),
    ...(behavior?.blockedAuthors ?? []),
  ]);
  return [...new Set(authorIds ?? [])].filter((id) => !excluded.has(id));
}
