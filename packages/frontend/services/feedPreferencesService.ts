import { authenticatedClient } from '@/utils/api';
import type { SavedFeed } from '@mention/shared-types';
import { logger } from '@/lib/logger';
import { normalizeApiError } from '@/utils/apiError';

interface FeedPreferencesResponse {
  savedFeeds: SavedFeed[];
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
    logger.error(`feedPreferencesService.${operation} failed`, {
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
  async get(): Promise<SavedFeed[]> {
    return run('get', async () => {
      const res = await authenticatedClient.get<FeedPreferencesResponse>('/feed/preferences');
      return res.data.savedFeeds ?? [];
    });
  }

  async update(savedFeeds: SavedFeed[]): Promise<SavedFeed[]> {
    return run('update', async () => {
      const res = await authenticatedClient.put<FeedPreferencesResponse>('/feed/preferences', { savedFeeds });
      return res.data.savedFeeds ?? savedFeeds;
    });
  }
}

export const feedPreferencesService = new FeedPreferencesService();
