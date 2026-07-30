import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services/ui/client';
import type { PostUser } from '@mention/shared-types';
import { feedService } from '@/services/feedService';
import { isAuthError } from '@/utils/authErrors';
import { logger } from '@oxyhq/core/logger';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

/**
 * How long a fetched sample stays fresh before React Query refetches it. Long
 * enough that opening a thread and stepping back out does not re-hit the
 * endpoint, short enough that the row reflects a like the viewer's friend just
 * made by the time they look again.
 */
const KNOWN_LIKERS_STALE_TIME_MS = 60_000;

export interface KnownLikersResult {
  /** The avatar sample the server returned (bounded server-side). */
  likers: PostUser[];
  /** Every liker the viewer follows, not just the sampled ones. */
  total: number;
  /** True only while the first authenticated fetch is in flight. */
  isPending: boolean;
}

/**
 * The people the signed-in viewer follows who liked a given post — the social
 * proof row on the post-detail screen.
 *
 * Modelled on `useMutualFollowers`, and viewer-relative for the same reason: the
 * follow graph is derived from the auth token server-side, never passed as a
 * param. The query is therefore keyed on the viewer identity so the cold-boot
 * session landing (`anon` -> `<viewerId>`) refetches automatically, and gated on
 * `canUsePrivateApi` so nothing fires before a usable bearer exists. Auth errors
 * fail quietly to an empty result; other errors propagate so React Query applies
 * its bounded retry.
 *
 * Disabled (returns empty, never fetches) when signed out or before the private
 * API is ready — the endpoint answers 200 with an empty result for anonymous
 * callers anyway, so there is nothing to fetch.
 */
export function useKnownLikers(postId?: string): KnownLikersResult {
  const { user, isAuthenticated, canUsePrivateApi } = useAuth();
  const viewerId = user?.id;

  const enabled = isAuthenticated && Boolean(viewerId) && canUsePrivateApi && Boolean(postId);

  const query = useQuery<{ likers: PostUser[]; total: number }>({
    queryKey: viewerQueryKeys.knownLikers(viewerId, postId),
    queryFn: async () => {
      if (!postId) return { likers: [], total: 0 };
      try {
        const result = await feedService.getKnownPostLikers(postId);
        return { likers: result.likers, total: result.total };
      } catch (err) {
        if (isAuthError(err)) {
          logger.warn('Auth error loading known likers, showing empty', { error: err });
          return { likers: [], total: 0 };
        }
        throw err;
      }
    },
    enabled,
    staleTime: KNOWN_LIKERS_STALE_TIME_MS,
  });

  return useMemo<KnownLikersResult>(
    () => ({
      likers: query.data?.likers ?? [],
      total: query.data?.total ?? 0,
      isPending: query.isLoading,
    }),
    [query.data, query.isLoading],
  );
}
