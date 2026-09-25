import { useCallback } from 'react';
import { keepPreviousData, useQueries, type UseQueryResult } from '@tanstack/react-query';
import { logger } from '@oxy.so/core/logger';

import { viewerQueryKeys, type ViewerId } from '@/lib/viewerQueryKeys';
import {
  isAbortError,
  mergeSearchResults,
  searchAllSources,
  searchService,
  type SearchResults,
} from '@/services/searchService';

export interface SearchAllSourcesOptions {
  viewerId: ViewerId;
  /** The committed (debounced, trimmed) query. */
  query: string;
  canUsePrivateApi: boolean;
  /** False off the "All" tab or with no query; nothing is fetched. */
  enabled: boolean;
  staleTime: number;
  gcTime: number;
}

export interface SearchAllSourcesState {
  /** Every section, filled from whichever sources have answered so far. */
  results: Required<SearchResults>;
  /** Nothing to show yet: no source has answered and not all have failed. */
  loading: boolean;
  /** Some source is still fetching — a section yet to land, or a refinement. */
  fetching: boolean;
  /** Every source that ran failed, and there is nothing to show. */
  failed: boolean;
  retry: () => void;
}

/**
 * The "All" search tab, one query per source.
 *
 * It was one query awaiting all four sources, so the screen showed nothing
 * until the SLOWEST answered: in production the people and hashtag sections
 * were ready in well under a second and sat behind the posts search for 3–7s
 * (issue #1140). Each source is now its own query and the screen renders each
 * section as it lands; `fetching` drives the refreshing hairline while the
 * rest are still on their way.
 *
 * Which sources run, and what each one fills, is `searchService`'s
 * (`searchAllSources`, `searchAllSource`) — the same pieces its combined
 * `searchAll` uses. `keepPreviousData` keeps a source's sections on screen
 * while a refined query refetches it, as the single-query version did.
 */
export function useSearchAllSources({
  viewerId,
  query,
  canUsePrivateApi,
  enabled,
  staleTime,
  gcTime,
}: SearchAllSourcesOptions): SearchAllSourcesState {
  const sources = searchAllSources(canUsePrivateApi);

  // Stable, so React Query can keep returning the SAME combined object while no
  // source changed — an inline `combine` would rebuild it (and every memo the
  // screen keys on `results`) on each render.
  const combine = useCallback(
    (queries: UseQueryResult<SearchResults>[]): SearchAllSourcesState => {
      const answered = queries.flatMap((q) => (q.data === undefined ? [] : [q.data]));
      const failed = enabled && queries.length > 0 && queries.every((q) => q.isError && q.data === undefined);
      return {
        results: mergeSearchResults(answered),
        loading: enabled && answered.length === 0 && !failed,
        fetching: enabled && queries.some((q) => q.isFetching),
        failed,
        retry: () => queries.forEach((q) => void q.refetch()),
      };
    },
    [enabled],
  );

  return useQueries({
    queries: sources.map((source) => ({
      queryKey: viewerQueryKeys.searchAllSource(viewerId, source, query),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        searchService.searchAllSource(source, query, signal).catch((error: unknown) => {
          if (!isAbortError(error)) logger.warn('A search source failed', { source, error });
          throw error;
        }),
      enabled,
      staleTime,
      gcTime,
      // Fail to the section being absent (or, if every source fails, the
      // error state and its Retry) rather than stacking React Query retries on
      // the transport's own bounded timeout.
      retry: false,
      placeholderData: keepPreviousData,
    })),
    combine,
  });
}
