import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from '@oxyhq/bloom/toast';
import { logger } from '@oxyhq/core/logger';
import { authenticatedClient, isUnauthorizedError, isNotFoundError } from '@/utils/api';
import { useAuth } from '@oxyhq/services/ui/client';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import type { UserSettingsResponse } from '@/hooks/usePrivacySettings';

export interface FeedSettings {
  diversity: {
    enabled: boolean;
    sameAuthorPenalty: number; // 0.5 - 1.0
    sameTopicPenalty: number; // 0.5 - 1.0
    maxConsecutiveSameAuthor?: number; // Max posts from same author in a row
  };
  recency: {
    halfLifeHours: number; // 6 - 72 hours
    maxAgeHours: number; // 24 - 336 hours (14 days)
  };
  quality: {
    minEngagementRate?: number; // Minimum engagement rate threshold
    boostHighQuality: boolean;
  };
}

export const DEFAULT_FEED_SETTINGS: FeedSettings = {
  diversity: {
    enabled: true,
    sameAuthorPenalty: 0.95,
    sameTopicPenalty: 0.92,
  },
  recency: {
    halfLifeHours: 24,
    maxAgeHours: 168,
  },
  quality: {
    boostHighQuality: true,
  },
};

/** Fill in every field the server omitted, so readers never see a partial shape. */
function withDefaults(partial: Partial<FeedSettings> | undefined): FeedSettings {
  return {
    ...DEFAULT_FEED_SETTINGS,
    ...partial,
    diversity: { ...DEFAULT_FEED_SETTINGS.diversity, ...partial?.diversity },
    recency: { ...DEFAULT_FEED_SETTINGS.recency, ...partial?.recency },
    quality: { ...DEFAULT_FEED_SETTINGS.quality, ...partial?.quality },
  };
}

export interface UseFeedSettings {
  /** The viewer's settings — server state, or the defaults while anonymous. */
  settings: FeedSettings;
  isLoading: boolean;
  /** Whether the viewer can persist a change (signed in). */
  canEdit: boolean;
  /** Whether a save is in flight. */
  isSaving: boolean;
  /**
   * Show a value without persisting it — for a control that emits continuously,
   * like a slider being dragged. Writes the cache only, so the UI tracks the
   * gesture while the network stays quiet. Always followed by {@link save}.
   */
  preview: (next: FeedSettings) => void;
  /** Persist a change immediately, optimistically, rolling back on failure. */
  save: (next: FeedSettings) => void;
}

/**
 * The viewer's server-persisted feed ranking settings.
 *
 * Server state is the ONLY state: there is no local draft and no save button.
 * A control writes through {@link UseFeedSettings.save}, which updates the cache
 * optimistically and reverts — visibly, with a toast — if the write fails. That
 * is what makes an instant-save screen honest; a setting that appears to change
 * and quietly did not is worse than one that visibly refuses.
 *
 * Keyed on the auth identity so the settings reload when a session resolves on
 * cold boot or an account switches, and gated on `canUsePrivateApi` so the
 * private endpoint is never hit while anonymous.
 */
export function useFeedSettings(): UseFeedSettings {
  const { t } = useTranslation();
  const { user, canUsePrivateApi } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => viewerQueryKeys.feedSettings(user?.id),
    [user?.id],
  );

  const query = useQuery<FeedSettings>({
    queryKey,
    enabled: canUsePrivateApi,
    staleTime: 5 * 60 * 1000,
    queryFn: async ({ signal }) => {
      try {
        const response = await authenticatedClient.get<UserSettingsResponse>(
          '/profile/settings/me',
          { signal },
        );
        return withDefaults(response.data?.feedSettings);
      } catch (error: unknown) {
        // A viewer who has never saved settings has no document yet, and an
        // expired token resolves to the same "nothing of your own" answer.
        if (isUnauthorizedError(error) || isNotFoundError(error)) {
          return DEFAULT_FEED_SETTINGS;
        }
        throw error;
      }
    },
  });

  const mutation = useMutation<
    FeedSettings,
    Error,
    FeedSettings,
    { previous: FeedSettings | undefined }
  >({
    mutationFn: async (next) => {
      const response = await authenticatedClient.put<UserSettingsResponse>(
        '/profile/settings',
        { feedSettings: next },
      );
      return withDefaults(response.data?.feedSettings ?? next);
    },
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<FeedSettings>(queryKey);
      queryClient.setQueryData<FeedSettings>(queryKey, next);
      return { previous };
    },
    onError: (error, _next, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData<FeedSettings>(queryKey, context.previous);
      }
      logger.error('Failed to save feed settings', error);
      toast(
        t('settings.feed.saveError', {
          defaultValue: "Couldn't save that setting. Please try again.",
        }),
        { type: 'error' },
      );
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const preview = useCallback(
    (next: FeedSettings) => {
      if (!canUsePrivateApi) return;
      queryClient.setQueryData<FeedSettings>(queryKey, next);
    },
    [canUsePrivateApi, queryClient, queryKey],
  );

  const { mutate } = mutation;
  const save = useCallback(
    (next: FeedSettings) => {
      if (!canUsePrivateApi) return;
      mutate(next);
    },
    [canUsePrivateApi, mutate],
  );

  return {
    settings: query.data ?? DEFAULT_FEED_SETTINGS,
    isLoading: canUsePrivateApi && query.isLoading,
    canEdit: canUsePrivateApi,
    isSaving: mutation.isPending,
    preview,
    save,
  };
}
