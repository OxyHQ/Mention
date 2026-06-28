import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useTheme } from '@oxyhq/bloom/theme';
import { api } from '@/utils/api';

const SEARCH_DEBOUNCE_MS = 350;

/** The catalog facets the `profile/media/search` proxy can search. */
export type CatalogSearchType = 'song' | 'podcast';

/**
 * One page of catalog search rows plus the offset to request next. `nextOffset`
 * advances by the page size (`limit`), not by `rows.length`: the SDK can return a
 * short page while more results remain.
 */
export interface SearchResultPage<T> {
  rows: T[];
  hasMore: boolean;
  nextOffset: number;
}

/**
 * The raw proxy envelope. `profile/media/search` returns a `{ data, pagination }`
 * shape which `@oxyhq/core`'s HttpService leaves un-unwrapped (the `pagination`
 * key suppresses the `{ data }` unwrap), so the rows live at `res.data.data` and
 * the page metadata at `res.data.pagination`.
 */
export interface PaginatedSearchEnvelope<T> {
  data: T[];
  pagination: { hasMore: boolean; offset: number; limit: number };
}

async function fetchCatalogPage<T>(
  type: CatalogSearchType,
  query: string,
  offset: number,
): Promise<SearchResultPage<T>> {
  const res = await api.get<PaginatedSearchEnvelope<T>>('profile/media/search', {
    type,
    q: query,
    offset,
  });
  const rows = res.data?.data ?? [];
  const pagination = res.data?.pagination;
  return {
    rows,
    hasMore: pagination?.hasMore ?? false,
    nextOffset: (pagination?.offset ?? 0) + (pagination?.limit ?? rows.length),
  };
}

export interface InfiniteCatalogSearch<T> {
  /** All loaded pages flattened into a single, render-ready list. */
  results: T[];
  isLoading: boolean;
  isError: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  /**
   * Whether a non-empty *debounced* query is active. Drives the "type to search"
   * hint vs. the "no results" empty state — the caller can't derive this from the
   * raw input because the input leads the debounced query by `SEARCH_DEBOUNCE_MS`.
   */
  hasQuery: boolean;
  loadMore: () => void;
}

/**
 * Infinite, debounced search over the Syra catalog proxy
 * (`profile/media/search?type=`). The caller owns the text-input + tab state and
 * feeds the raw `query` in; the hook owns the 350ms debounce, the paginated
 * `useInfiniteQuery`, the flattened `results`, and the guarded `loadMore`.
 *
 * For a facet that is not the active tab, pass an empty `query` (and
 * `enabled: false`) so its debounced query can never go stale and flash the
 * previous tab's results — or fire a wasted fetch — the moment it becomes active.
 */
export function useInfiniteCatalogSearch<T>(
  type: CatalogSearchType,
  query: string,
  opts?: { enabled?: boolean },
): InfiniteCatalogSearch<T> {
  const [debouncedQuery, setDebouncedQuery] = useState('');

  // Debounce the raw input into the query key (the only effect here — React
  // Query owns the actual fetch, dedupe, and caching).
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  const search = useInfiniteQuery({
    queryKey: ['profile-media-search', type, debouncedQuery],
    queryFn: ({ pageParam }) => fetchCatalogPage<T>(type, debouncedQuery, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.hasMore ? last.nextOffset : undefined),
    enabled: (opts?.enabled ?? true) && debouncedQuery.length > 0,
    staleTime: 60_000,
  });

  const results = useMemo(
    () => search.data?.pages.flatMap((page) => page.rows) ?? [],
    [search.data],
  );

  const loadMore = useCallback(() => {
    if (search.hasNextPage && !search.isFetchingNextPage) {
      void search.fetchNextPage();
    }
  }, [search.hasNextPage, search.isFetchingNextPage, search.fetchNextPage]);

  return {
    results,
    isLoading: search.isLoading,
    isError: search.isError,
    isFetchingNextPage: search.isFetchingNextPage,
    hasNextPage: search.hasNextPage,
    hasQuery: debouncedQuery.length > 0,
    loadMore,
  };
}

/** Spinner shown at the bottom of a results list while the next page loads. */
export const ResultsFooter = memo(function ResultsFooter({ loading }: { loading: boolean }) {
  const { colors } = useTheme();
  if (!loading) {
    return null;
  }
  return (
    <View className="items-center justify-center py-3">
      <ActivityIndicator size="small" color={colors.primary} />
    </View>
  );
});
