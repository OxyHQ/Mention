import { useState, useEffect, useCallback } from 'react';
import { authenticatedClient, isUnauthorizedError, isNotFoundError } from '@/utils/api';

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

const DEFAULT_FEED_SETTINGS: FeedSettings = {
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
  const [settings, setSettings] = useState<FeedSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authenticatedClient.get('/profile/settings/me');
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
    } catch (err: any) {
      if (isUnauthorizedError(err) || isNotFoundError(err)) {
        setSettings(DEFAULT_FEED_SETTINGS);
      } else {
        console.error('Error loading feed settings:', err);
        setError(err);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const updateSettings = useCallback(async (updates: Partial<FeedSettings>): Promise<void> => {
    try {
      const response = await authenticatedClient.put('/profile/settings', {
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
    } catch (err: any) {
      console.error('Error updating feed settings:', err);
      throw err;
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  return {
    settings: settings || DEFAULT_FEED_SETTINGS,
    loading,
    error,
    updateSettings,
    reloadSettings: loadSettings,
  };
}



