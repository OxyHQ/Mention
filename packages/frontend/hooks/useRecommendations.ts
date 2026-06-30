/**
 * Shared "who to follow" recommendations hooks.
 *
 * `GET /recommendations` is a public, cursor-paginated discovery surface read by
 * several UI surfaces (the explore Who-to-follow tab, the right-rail widget, the
 * profile/notifications suggestion strips, and the connections "Who may know"
 * tab). Both hooks here are the SINGLE React Query owners for that read so the
 * surfaces share cache instead of each re-fetching on mount:
 *
 *  - {@link useRecommendations} — one page; widgets/connections slice it.
 *  - {@link useInfiniteRecommendations} — cursor pagination for the tab, with a
 *    flattened, id-deduped list + `fetchNextPage`/`hasNextPage`.
 *
 * Both key on `excludeTypesCsv` (derived from the viewer's persisted filters, a
 * sibling query so a filter change refetches reactively) and on `viewerId` (so
 * anon vs. authed stay separate and the list reloads when the cold-boot session
 * lands). The per-page fetch + filter + precache + avatar-enrich + auth soft-fail
 * is the shared {@link loadRecommendationsPage}; the shared cache/key derivation
 * is {@link useRecommendationParams}.
 */

import { useCallback, useMemo } from 'react';
import { useInfiniteQuery, useQuery, keepPreviousData } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services';
import type { User } from '@oxyhq/core';
import { queryClient } from '@/lib/queryClient';
import { precacheProfileViews } from '@/lib/precacheProfiles';
import { enrichMissingAvatars } from '@/utils/userEnrichment';
import { isAuthError } from '@/utils/authErrors';
import { logger } from '@/lib/logger';
import {
  fetchRecommendationsPage,
  deriveExcludeTypes,
  type ProfileData,
  type RecommendationExcludeType,
  type RecommendationsPage,
} from '@/lib/recommendations';
import {
  getRecommendationFilters,
  DEFAULT_RECOMMENDATION_FILTERS,
} from '@/lib/recommendationFilters';

/** Single-page size for the widgets/connections (the backend caps at 50). */
const RECOMMENDATIONS_SINGLE_PAGE_SIZE = 50;

/** Per-page size for the infinite who-to-follow tab. */
const RECOMMENDATIONS_INFINITE_PAGE_SIZE = 20;

/** Recommendations stay fresh for 5 minutes across all surfaces before a refetch. */
const RECOMMENDATIONS_STALE_TIME_MS = 5 * 60_000;

/**
 * Query key for the viewer's persisted recommendation filters. The settings
 * screen writes this key (via `queryClient.setQueryData`) when a filter toggles,
 * so the derived `excludeTypesCsv` — and therefore the recommendations cache key
 * — updates reactively without a manual invalidation.
 */
export const RECOMMENDATION_FILTERS_QUERY_KEY = ['recommendationFilters'] as const;

export interface UseRecommendationsOptions {
  /** Skip fetching while false (e.g. an inactive tab). Defaults to true. */
  enabled?: boolean;
  /**
   * Override the persisted filters' `excludeTypes`. When provided the filters
   * query is bypassed for key derivation; used by callers that need a fixed set.
   */
  excludeTypes?: RecommendationExcludeType[];
}

/**
 * Fetch + normalize ONE recommendations page: drop id-less items, prime the
 * actor cache, background-fill missing avatars, and soft-fail an auth error to an
 * empty page (other errors propagate so React Query retries). Shared verbatim by
 * the single-page and infinite hooks so neither duplicates this logic.
 */
async function loadRecommendationsPage(
  getUsersByIds: (ids: string[]) => Promise<User[]>,
  excludeTypes: RecommendationExcludeType[],
  limit: number,
  cursor?: string,
): Promise<RecommendationsPage> {
  try {
    const page = await fetchRecommendationsPage({ excludeTypes, limit, cursor });
    const users = page.recommendations.filter((u) => u.id.length > 0);
    if (users.length > 0) {
      precacheProfileViews(queryClient, users);
      void enrichMissingAvatars(users, getUsersByIds, queryClient);
    }
    return { ...page, recommendations: users };
  } catch (err) {
    if (isAuthError(err)) {
      logger.warn('useRecommendations: auth error fetching recommendations, showing empty list');
      return { recommendations: [], nextCursor: null, nextOffset: null, hasMore: false };
    }
    throw err;
  }
}

interface RecommendationParams {
  getUsersByIds: (ids: string[]) => Promise<User[]>;
  viewerId: string;
  excludeTypes: RecommendationExcludeType[];
  excludeTypesCsv: string;
  enabled: boolean;
}

/**
 * Shared cache-key derivation for both recommendation hooks: the viewer id, the
 * `excludeTypes` (from an override or the persisted-filters sibling query) and
 * its CSV, the `enabled` gate, and a stable bound `getUsersByIds`.
 */
function useRecommendationParams(opts?: UseRecommendationsOptions): RecommendationParams {
  const { oxyServices, user } = useAuth();
  const viewerId = user?.id ?? 'anon';

  // Sibling query for the persisted filters — read once, kept forever fresh; the
  // settings screen primes it on change so the derived CSV stays in lockstep.
  const filtersQuery = useQuery({
    queryKey: RECOMMENDATION_FILTERS_QUERY_KEY,
    queryFn: getRecommendationFilters,
    staleTime: Infinity,
  });

  const overrideExcludeTypes = opts?.excludeTypes;
  const excludeTypes =
    overrideExcludeTypes ?? deriveExcludeTypes(filtersQuery.data ?? DEFAULT_RECOMMENDATION_FILTERS);
  const excludeTypesCsv = excludeTypes.join(',');

  const enabled =
    (opts?.enabled ?? true) && (overrideExcludeTypes != null || filtersQuery.isSuccess);

  const getUsersByIds = useCallback(
    (ids: string[]) => oxyServices.getUsersByIds(ids),
    [oxyServices],
  );

  return { getUsersByIds, viewerId, excludeTypes, excludeTypesCsv, enabled };
}

export interface UseRecommendationsResult {
  recommendations: ProfileData[];
  /** First load with no cached data yet (show a skeleton/spinner). */
  isLoading: boolean;
  /** Any fetch in flight, including background refetches (drives pull-to-refresh). */
  isFetching: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Single-page recommendations. Fetches one page and exposes it as a flat list;
 * widgets slice it (~5), the connections tab shows it. NOT paginated — use
 * {@link useInfiniteRecommendations} for infinite scroll.
 */
export function useRecommendations(opts?: UseRecommendationsOptions): UseRecommendationsResult {
  const { getUsersByIds, viewerId, excludeTypes, excludeTypesCsv, enabled } =
    useRecommendationParams(opts);

  const query = useQuery<ProfileData[]>({
    queryKey: ['recommendations', viewerId, excludeTypesCsv],
    queryFn: () =>
      loadRecommendationsPage(getUsersByIds, excludeTypes, RECOMMENDATIONS_SINGLE_PAGE_SIZE).then(
        (page) => page.recommendations,
      ),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: RECOMMENDATIONS_STALE_TIME_MS,
  });

  return {
    recommendations: query.data ?? [],
    isLoading: query.isPending,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error instanceof Error ? query.error : null,
    refetch: () => {
      void query.refetch();
    },
  };
}

export interface UseInfiniteRecommendationsResult {
  /** Flattened, id-deduped recommendations across all loaded pages. */
  recommendations: ProfileData[];
  /** First page loading with nothing cached yet. */
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  /** Refetch from the first page (pull-to-refresh). */
  refetch: () => void;
  /** A top-level refetch (not a next-page fetch) is in flight. */
  isRefetching: boolean;
  /** Load the next page (no-op when none / already loading). */
  fetchNextPage: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
}

/**
 * Cursor-paginated recommendations for the who-to-follow tab. Pages forward by
 * echoing the previous page's `nextCursor`; the flattened list is deduped by id
 * (ranking is only loosely stable within a short window, so an occasional
 * cross-page overlap is filtered out cheaply on the client).
 */
export function useInfiniteRecommendations(
  opts?: UseRecommendationsOptions,
): UseInfiniteRecommendationsResult {
  const { getUsersByIds, viewerId, excludeTypes, excludeTypesCsv, enabled } =
    useRecommendationParams(opts);

  const query = useInfiniteQuery({
    queryKey: ['recommendations', 'infinite', viewerId, excludeTypesCsv],
    queryFn: ({ pageParam }) =>
      loadRecommendationsPage(
        getUsersByIds,
        excludeTypes,
        RECOMMENDATIONS_INFINITE_PAGE_SIZE,
        pageParam ?? undefined,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled,
    staleTime: RECOMMENDATIONS_STALE_TIME_MS,
  });

  const recommendations = useMemo(() => {
    const seen = new Set<string>();
    const flat: ProfileData[] = [];
    for (const page of query.data?.pages ?? []) {
      for (const item of page.recommendations) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        flat.push(item);
      }
    }
    return flat;
  }, [query.data]);

  return {
    recommendations,
    isLoading: query.isPending,
    isError: query.isError,
    error: query.error instanceof Error ? query.error : null,
    refetch: () => {
      void query.refetch();
    },
    isRefetching: query.isRefetching,
    fetchNextPage: () => {
      void query.fetchNextPage();
    },
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
  };
}
