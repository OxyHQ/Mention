import { authenticatedClient } from '@/utils/api';
import type { ForYouFeedTuning } from '@mention/shared-types';
import { logger } from '@/lib/logger';
import { normalizeApiError } from '@/utils/apiError';

interface FeedTuningResponse {
  forYou: ForYouFeedTuning;
}

/**
 * Run a feed-tuning request, logging and rethrowing (with the original error
 * preserved as `cause`) on failure. Mirrors `feedPreferencesService.run` so
 * callers get a consistent, loud failure surface.
 */
async function run<T>(operation: string, request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    const normalized = normalizeApiError(error);
    logger.error(`feedTuningService.${operation} failed`, {
      status: normalized.status,
      code: normalized.code,
      message: normalized.message,
    });
    throw new Error(normalized.message, { cause: error });
  }
}

/**
 * The viewer's Mention-local For You discovery-gate tuning (Phase 4B). These are
 * per-user overrides merged OVER the `MtnConfig.feed.discoveryGate` defaults on
 * the server, so an empty object means "use the config-default gate". The server
 * validates every payload against `FOR_YOU_TUNING_MODULES` before persisting.
 */
class FeedTuningService {
  async get(): Promise<ForYouFeedTuning> {
    return run('get', async () => {
      const res = await authenticatedClient.get<FeedTuningResponse>('/feed/tuning');
      return res.data.forYou ?? {};
    });
  }

  async update(forYou: ForYouFeedTuning): Promise<ForYouFeedTuning> {
    return run('update', async () => {
      const res = await authenticatedClient.put<FeedTuningResponse>('/feed/tuning', { forYou });
      return res.data.forYou ?? forYou;
    });
  }
}

export const feedTuningService = new FeedTuningService();
