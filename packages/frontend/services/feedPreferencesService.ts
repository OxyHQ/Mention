import { authenticatedClient } from '@/utils/api';
import type { FeedPreferences, SavedFeed } from '@mention/shared-types';
import { logger } from '@oxy.so/core/logger';
import { normalizeApiError } from '@/utils/apiError';

/**
 * `GET /feed/preferences`: the layout, plus the title of every pinned custom
 * feed the viewer may still read, keyed by feed id — what the home tab bar
 * labels them with. A pinned feed missing from it was deleted or made private.
 */
export interface FeedPreferencesResponse extends FeedPreferences {
  customFeedTitles?: Record<string, string>;
}

/**
 * Run a feed-preferences request, logging and rethrowing (with the original
 * error preserved as `cause`) on failure. Mirrors `customFeedsService.run` so
 * callers get a consistent, loud failure surface.
 */
async function run<T>(operation: string, request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    const normalized = normalizeApiError(error);
    logger.error(`feedPreferencesService.${operation} failed`, undefined, {
      status: normalized.status,
      code: normalized.code,
      message: normalized.message,
    });
    throw new Error(normalized.message, { cause: error });
  }
}

/**
 * Server-persisted feed layout (saved / pinned / ordered feeds). The backend
 * merges the viewer's stored layout with the `PRESET_FEEDS` defaults on GET, so
 * a signed-in caller always receives the full catalog.
 */
class FeedPreferencesService {
  async get(): Promise<FeedPreferencesResponse> {
    return run('get', async () => {
      const res = await authenticatedClient.get<FeedPreferencesResponse>('/feed/preferences');
      return {
        savedFeeds: res.data.savedFeeds ?? [],
        customFeedTitles: res.data.customFeedTitles ?? {},
      };
    });
  }

  async update(savedFeeds: SavedFeed[]): Promise<SavedFeed[]> {
    return run('update', async () => {
      const res = await authenticatedClient.put<FeedPreferencesResponse>('/feed/preferences', {
        savedFeeds,
      });
      return res.data.savedFeeds ?? savedFeeds;
    });
  }
}

export const feedPreferencesService = new FeedPreferencesService();
