import { NO_POST_SEARCH_FILTERS, POPULAR_MIN_LIKES, postSearchParams } from '../postSearchFilters';

const NOW = Date.UTC(2026, 0, 8);

it('sends nothing when no filter is on', () => {
  expect(postSearchParams(NO_POST_SEARCH_FILTERS, NOW)).toEqual({});
});

it('sends each filter as the parameter the search route reads', () => {
  expect(postSearchParams({ media: true, pastWeek: true, popular: true }, NOW)).toEqual({
    hasMedia: 'true',
    dateFrom: '2026-01-01T00:00:00.000Z',
    minLikes: String(POPULAR_MIN_LIKES),
  });
});
