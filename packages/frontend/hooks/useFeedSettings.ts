import type { FollowingFeedSort } from '@mention/shared-types';
import { notifyFeedRankingChanged } from '@/stores/feedRankingInvalidation';
import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from '@oxy.so/bloom/toast';
import { logger } from '@oxy.so/core/logger';
import { useAuth } from '@oxy.so/services/ui/client';
import {
  saveViewerSettings,
  updateCachedViewerSettings,
  viewerSettingsQuery,
  type UserSettingsResponse,
} from '@/lib/viewerSettings';

export interface FeedSettings {
  following: { sort: FollowingFeedSort };
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
  following: { sort: 'chronological' },
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

const selectFeedSettings = (settings: UserSettingsResponse): FeedSettings =>
  withDefaults(settings.feedSettings);

/** Fill in every field the server omitted, so readers never see a partial shape. */
function withDefaults(partial: Partial<FeedSettings> | undefined): FeedSettings {
  return {
    ...DEFAULT_FEED_SETTINGS,
    ...partial,
    following: { ...DEFAULT_FEED_SETTINGS.following, ...partial?.following },
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
  const viewerId = user?.id;

  // The shared settings document; this hook reads only its feed section.
  const query = useQuery({
    ...viewerSettingsQuery(viewerId),
    enabled: canUsePrivateApi,
    select: selectFeedSettings,
  });

  const paint = useCallback(
    (next: FeedSettings) =>
      updateCachedViewerSettings(queryClient, viewerId, (current) => ({
        ...current,
        feedSettings: next,
      })),
    [queryClient, viewerId],
  );

  const mutation = useMutation<
    UserSettingsResponse,
    Error,
    FeedSettings,
    { previous: UserSettingsResponse | undefined; viewerId?: string }
  >({
    mutationFn: (next) => saveViewerSettings(viewerId, { feedSettings: next }, queryClient),
    onMutate: async (next) => {
      const queryKey = viewerSettingsQuery(viewerId).queryKey;
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<UserSettingsResponse>(queryKey);
      paint(next);
      return { previous, viewerId };
    },
    onError: (error, _next, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(viewerSettingsQuery(context.viewerId).queryKey, context.previous);
      }
      logger.error('Failed to save feed settings', error);
      toast(
        t('settings.feed.saveError', {
          defaultValue: "Couldn't save that setting. Please try again.",
        }),
        { type: 'error' },
      );
    },
    onSuccess: (_data, _next, context) => {
      notifyFeedRankingChanged(context?.viewerId, false);
    },
  });

  const preview = useCallback(
    (next: FeedSettings) => {
      if (!canUsePrivateApi) return;
      paint(next);
    },
    [canUsePrivateApi, paint],
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
