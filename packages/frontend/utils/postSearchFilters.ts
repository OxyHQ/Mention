/** The narrowing the Posts search tab offers, each one a parameter `GET /search` takes. */
export interface PostSearchFilters {
  media: boolean;
  pastWeek: boolean;
  popular: boolean;
}

export const NO_POST_SEARCH_FILTERS: PostSearchFilters = {
  media: false,
  pastWeek: false,
  popular: false,
};

/** Likes a post needs to count as popular. */
export const POPULAR_MIN_LIKES = 10;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function postSearchParams(
  filters: PostSearchFilters,
  now: number = Date.now(),
): Record<string, string> {
  return {
    ...(filters.media ? { hasMedia: 'true' } : {}),
    ...(filters.pastWeek ? { dateFrom: new Date(now - WEEK_MS).toISOString() } : {}),
    ...(filters.popular ? { minLikes: String(POPULAR_MIN_LIKES) } : {}),
  };
}
