import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services';
import type { User } from '@oxyhq/core';
import { isAuthError } from '@/utils/authErrors';
import { logger } from '@/lib/logger';

/**
 * How long a fetched mutuals sample stays fresh before React Query refetches it.
 * Mutual-follower overlap changes slowly; a short client window keeps the social
 * proof reasonably current without re-hitting the endpoint on every profile view.
 */
const MUTUALS_STALE_TIME_MS = 60_000;

/** Size of the avatar sample rendered in the "Followed by" row. */
const MUTUALS_SAMPLE_LIMIT = 3;

export interface MutualFollowersResult {
  /** Up to {@link MUTUALS_SAMPLE_LIMIT} mutual followers, for the avatar sample. */
  mutuals: User[];
  /** The real total number of mutual followers (drives the "and N others" copy). */
  total: number;
  /** True only while the first authenticated fetch is in flight. */
  isPending: boolean;
}

/**
 * Mutual followers ("followers you know") between the signed-in viewer and the
 * profile being viewed — people the viewer follows who also follow `profileId`.
 *
 * Viewer-relative and private: the SDK derives the viewer from the auth token
 * server-side. We therefore key the query on the viewer identity (`user?.id`) so
 * the cold-boot session landing (`anon` -> `<viewerId>`) refetches automatically,
 * and gate it on `canUsePrivateApi` so a request never fires before a usable
 * bearer exists (avoiding the 401-then-stale-empty trap documented for other
 * private endpoints). Auth errors fail quietly to an empty result; other errors
 * propagate so React Query applies its bounded retry.
 *
 * Disabled (returns empty, never fetches) for the viewer's own profile, signed
 * out, or before the private API is ready.
 */
export function useMutualFollowers(profileId?: string): MutualFollowersResult {
  const { oxyServices, user, isAuthenticated, canUsePrivateApi } = useAuth();
  const viewerId = user?.id;

  const enabled =
    isAuthenticated &&
    Boolean(viewerId) &&
    canUsePrivateApi &&
    Boolean(profileId) &&
    profileId !== viewerId;

  const query = useQuery<{ mutuals: User[]; total: number }>({
    queryKey: ['mutuals', profileId ?? '', viewerId ?? 'anon'],
    queryFn: async () => {
      if (!profileId) return { mutuals: [], total: 0 };
      try {
        const result = await oxyServices.getUserMutuals(profileId, {
          limit: MUTUALS_SAMPLE_LIMIT,
          offset: 0,
        });
        return { mutuals: result.mutuals, total: result.total };
      } catch (err) {
        if (isAuthError(err)) {
          logger.warn('Auth error loading mutual followers, showing empty', { error: err });
          return { mutuals: [], total: 0 };
        }
        throw err;
      }
    },
    enabled,
    staleTime: MUTUALS_STALE_TIME_MS,
  });

  return useMemo<MutualFollowersResult>(
    () => ({
      mutuals: query.data?.mutuals ?? [],
      total: query.data?.total ?? 0,
      isPending: query.isLoading,
    }),
    [query.data, query.isLoading],
  );
}
