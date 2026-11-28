import { useEffect, useState } from 'react';
import { createLogger } from '@oxy.so/core/logger';
import { type SearchHashtagResult, searchService } from '@/services/searchService';

const logger = createLogger('HashtagSuggestions');

export const HASHTAG_SUGGESTION_LIMIT = 5;
export const HASHTAG_SUGGESTION_DEBOUNCE_MS = 200;

const NONE: readonly SearchHashtagResult[] = [];

/**
 * Hashtags already in use that match what is being typed. Empty while the answer
 * for the current query is on its way, so a row can never complete to a tag the
 * text no longer asks for.
 */
export function useHashtagSuggestions(query: string | null): readonly SearchHashtagResult[] {
  const [answer, setAnswer] = useState<{
    query: string;
    tags: readonly SearchHashtagResult[];
  } | null>(null);

  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchService
        .searchHashtagsPage(query, 0, controller.signal)
        .then(({ hashtags }) => {
          if (controller.signal.aborted) return;
          setAnswer({ query, tags: hashtags.slice(0, HASHTAG_SUGGESTION_LIMIT) });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) logger.debug('Hashtag search failed', { error });
        });
    }, HASHTAG_SUGGESTION_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  return query && answer?.query === query ? answer.tags : NONE;
}
