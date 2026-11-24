import type { HydratedPost } from '@mention/shared-types';

const mockPrefetch = jest.fn((_uris: string[], _policy: string) => Promise.resolve(true));
jest.mock('expo-image', () => ({
  Image: { prefetch: (...args: [string[], string]) => mockPrefetch(...args) },
}));
jest.mock('@/lib/oxyServices', () => ({
  oxyServices: { cloudURL: 'https://cloud.oxy.so', assets: { renderUrl: (id: string) => id } },
}));
jest.mock('@/config', () => ({ CLARITY_API_URL: 'https://api.clarity.surf' }));

import { prefetchFeedImages } from '../feedImagePrefetch';

const post = (id: string) =>
  ({
    id,
    user: { id: `u-${id}`, avatar: `https://cdn.test/${id}.jpg` },
    content: {},
  }) as unknown as HydratedPost;

it('asks the cache for each image once, in one call per batch', () => {
  prefetchFeedImages([post('a'), post('b')]);
  expect(mockPrefetch).toHaveBeenCalledTimes(1);
  expect(mockPrefetch).toHaveBeenLastCalledWith(
    ['https://cdn.test/a.jpg', 'https://cdn.test/b.jpg'],
    'memory-disk',
  );
  prefetchFeedImages([post('b'), post('c')]);
  expect(mockPrefetch).toHaveBeenLastCalledWith(['https://cdn.test/c.jpg'], 'memory-disk');
  prefetchFeedImages([post('a'), post('c')]);
  expect(mockPrefetch).toHaveBeenCalledTimes(2);
});
