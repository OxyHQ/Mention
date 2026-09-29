import { useEffect, useState } from 'react';
import { logger } from '@oxy.so/core/logger';
import type { MentionSearchCache, MentionUser } from '@/utils/mentionSearch';

/** How long a query must hold still before it is searched. */
const SEARCH_DEBOUNCE_MS = 300;

export interface MentionSearchResults {
  users: MentionUser[];
  /** Nothing answers this query yet: its search is debouncing or in flight. */
  loading: boolean;
}

/**
 * The accounts the mention picker offers for `query`.
 *
 * Results the composer session already holds are returned at once. The same
 * cache answers a typed handle when it is completed, so reading from it here is
 * what keeps that from being a second request. Anything else is searched through
 * the cache after a short debounce.
 *
 * Results are kept WITH the query they answer: the previous query's accounts are
 * never offered for the current one while its search is still pending.
 *
 * Lives outside the picker so the input that owns the keyboard (arrows, Enter)
 * reads the same list the picker draws.
 */
export function useMentionSearchResults(
  query: string,
  searchCache: MentionSearchCache,
): MentionSearchResults {
  const [answered, setAnswered] = useState<{ query: string; users: MentionUser[] } | null>(null);

  const cached = query ? searchCache.peek(query) : undefined;

  useEffect(() => {
    if (!query || searchCache.peek(query)) return;

    let cancelled = false;
    const debounceTimer = setTimeout(async () => {
      let users: MentionUser[] = [];
      try {
        users = await searchCache.search(query);
      } catch (error) {
        logger.error('Error searching users for mentions', error);
      }
      if (!cancelled) setAnswered({ query, users });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(debounceTimer);
    };
  }, [query, searchCache]);

  if (!query) return { users: [], loading: false };
  if (cached) return { users: cached, loading: false };
  if (answered?.query === query) return { users: answered.users, loading: false };
  return { users: [], loading: true };
}
