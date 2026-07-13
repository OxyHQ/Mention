import { useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services';
import type { ForYouFeedTuning } from '@mention/shared-types';
import { feedTuningService } from '@/services/feedTuningService';
import { logger } from '@/lib/logger';

export interface UseForYouTuning {
  /** The viewer's stored For You tuning (empty ⇒ config-default gate). */
  tuning: ForYouFeedTuning;
  /** Persist a full replacement tuning object (optimistic, then invalidate). */
  save: (next: ForYouFeedTuning) => void;
  isLoading: boolean;
  /** Whether the viewer can persist changes (signed in). */
  canEdit: boolean;
}

/**
 * The viewer's Mention-local For You discovery-gate tuning.
 *
 * Keyed on the auth identity so the tuning reloads when a session resolves on
 * cold boot or an account switches, and gated on `canUsePrivateApi` so the
 * private endpoint is never hit while anonymous (AGENTS.md cold-boot rule).
 * Mirrors {@link useFeedPreferences}: reads via React Query, writes optimistically
 * then invalidates. Anonymous viewers get the empty (config-default) tuning.
 */
export function useForYouTuning(): UseForYouTuning {
  const { user, canUsePrivateApi } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['feedTuning', user?.id ?? 'anon'] as const, [user?.id]);

  const query = useQuery<ForYouFeedTuning>({
    queryKey,
    enabled: canUsePrivateApi,
    staleTime: 5 * 60 * 1000,
    queryFn: () => feedTuningService.get(),
  });

  const tuning = useMemo<ForYouFeedTuning>(() => query.data ?? {}, [query.data]);

  const mutation = useMutation<ForYouFeedTuning, Error, ForYouFeedTuning, { previous: ForYouFeedTuning | undefined }>({
    mutationFn: (next) => feedTuningService.update(next),
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ForYouFeedTuning>(queryKey);
      queryClient.setQueryData<ForYouFeedTuning>(queryKey, next);
      return { previous };
    },
    onError: (error, _next, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData<ForYouFeedTuning>(queryKey, context.previous);
      }
      logger.warn('Failed to persist For You tuning', { error });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const save = useCallback(
    (next: ForYouFeedTuning) => {
      if (!canUsePrivateApi) return;
      mutation.mutate(next);
    },
    [canUsePrivateApi, mutation],
  );

  return {
    tuning,
    save,
    isLoading: canUsePrivateApi && query.isLoading,
    canEdit: canUsePrivateApi,
  };
}
