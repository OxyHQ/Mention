import { useState, useEffect, useCallback } from 'react';
import { authenticatedClient, isUnauthorizedError, isNotFoundError } from '@/utils/api';
import { useAuth } from '@oxyhq/services';
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

/**
 * Hook to load and update current user's feed settings
 */
export function useFeedSettings() {
  const { isAuthenticated, isAuthResolved, canUsePrivateApi, isPrivateApiPending, user } = useAuth();
  const viewerId = user?.id;
  const [settings, setSettings] = useState<FeedSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const loadSettings = useCallback(async () => {
    if (!isAuthResolved || isPrivateApiPending) {
      return;
    }

    if (!canUsePrivateApi) {
      setSettings(DEFAULT_FEED_SETTINGS);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await authenticatedClient.get<UserSettingsResponse>('/profile/settings/me');
      if (response.data?.feedSettings) {
        // Merge with defaults to ensure all fields are present
        setSettings({
          ...DEFAULT_FEED_SETTINGS,
          ...response.data.feedSettings,
          diversity: {
            ...DEFAULT_FEED_SETTINGS.diversity,
            ...response.data.feedSettings.diversity,
          },
          recency: {
            ...DEFAULT_FEED_SETTINGS.recency,
            ...response.data.feedSettings.recency,
          },
          quality: {
            ...DEFAULT_FEED_SETTINGS.quality,
            ...response.data.feedSettings.quality,
          },
        });
      } else {
        setSettings(DEFAULT_FEED_SETTINGS);
      }
    } catch (err: unknown) {
      if (isUnauthorizedError(err) || isNotFoundError(err)) {
        setSettings(DEFAULT_FEED_SETTINGS);
      } else {
        setError(err instanceof Error ? err : new Error('Failed to load feed settings'));
      }
    } finally {
      setLoading(false);
    }
    // `isAuthenticated` is a dependency so the per-user feed settings load when
    // the auth session resolves on cold boot; the driving effect re-runs when
    // this callback's identity changes. The settings are scoped to the
    // signed-in user, so the anonymous-window fetch must be replaced once the
    // session lands.
  }, [canUsePrivateApi, isAuthResolved, isAuthenticated, isPrivateApiPending]);

  const updateSettings = useCallback(async (updates: Partial<FeedSettings>): Promise<void> => {
    if (!canUsePrivateApi) {
      throw new Error('Sign in to update feed settings');
    }

    try {
      const response = await authenticatedClient.put<UserSettingsResponse>('/profile/settings', {
        feedSettings: updates,
      });

      if (response.data?.feedSettings) {
        setSettings({
          ...DEFAULT_FEED_SETTINGS,
          ...response.data.feedSettings,
          diversity: {
            ...DEFAULT_FEED_SETTINGS.diversity,
            ...response.data.feedSettings.diversity,
          },
          recency: {
            ...DEFAULT_FEED_SETTINGS.recency,
            ...response.data.feedSettings.recency,
          },
          quality: {
            ...DEFAULT_FEED_SETTINGS.quality,
            ...response.data.feedSettings.quality,
          },
        });
      }
    } catch (err: unknown) {
      throw err;
    }
  }, [canUsePrivateApi]);

  useEffect(() => {
    loadSettings();
    // `viewerId` covers account switches; `loadSettings` re-runs the load when
    // the auth session resolves (its identity changes with `isAuthenticated`).
  }, [loadSettings, viewerId]);

  return {
    settings: settings || DEFAULT_FEED_SETTINGS,
    loading,
    error,
    updateSettings,
    reloadSettings: loadSettings,
  };
}








