import type { FeedItem } from '@/db';

/**
 * A post whose first read came back `documentsPending` must get its link cards
 * without a manual refresh: the ids are batched into one follow-up call, each
 * answer is written back to the post, and a post still pending is asked for
 * again a bounded number of times, then left alone.
 */

const mockGetPostDocuments = jest.fn();
const mockPosts = new Map<string, FeedItem>();

jest.mock('@/services/feedService', () => ({
  feedService: { getPostDocuments: (...args: unknown[]) => mockGetPostDocuments(...args) },
}));

jest.mock('../postsStore', () => ({
  usePostsStore: {
    getState: () => ({
      updatePostEverywhere: (postId: string, updater: (prev: FeedItem) => FeedItem) => {
        const prev = mockPosts.get(postId);
        if (prev) mockPosts.set(postId, updater(prev));
      },
    }),
  },
}));

jest.mock('@oxy.so/core/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

import { registerPendingDocuments, requestPendingDocuments, resetPendingDocumentsForTests } from '../pendingDocuments';
import { notifyPostsStored } from '@/db/postObservers';

const CARD = { id: 'doc-1', canonicalUrl: 'https://example.com/a', type: 'page', status: 'indexed', authors: [], evidence: {} };

function seed(id: string): void {
  mockPosts.set(id, { id, documents: [], documentsPending: true } as unknown as FeedItem);
}

async function advance(ms: number): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  jest.useFakeTimers();
  mockPosts.clear();
  mockGetPostDocuments.mockReset();
  resetPendingDocumentsForTests();
});

afterEach(() => {
  jest.useRealTimers();
});

it('batches every pending post on screen into one call and writes the cards back', async () => {
  seed('a');
  seed('b');
  mockGetPostDocuments.mockResolvedValue({ posts: { a: { documents: [CARD] }, b: { documents: [CARD] } } });

  requestPendingDocuments('a');
  requestPendingDocuments('b');
  requestPendingDocuments('a');
  await advance(1_500);

  expect(mockGetPostDocuments).toHaveBeenCalledTimes(1);
  expect(mockGetPostDocuments).toHaveBeenCalledWith(['a', 'b']);
  expect(mockPosts.get('a')?.documents).toEqual([CARD]);
  expect(mockPosts.get('a')?.documentsPending).toBeUndefined();

  // Settled: nothing further is asked.
  await advance(60_000);
  expect(mockGetPostDocuments).toHaveBeenCalledTimes(1);
});

it('asks again for a post that is still pending, then stops', async () => {
  seed('a');
  mockGetPostDocuments.mockResolvedValue({ posts: { a: { documents: [], documentsPending: true } } });

  requestPendingDocuments('a');
  await advance(1_500);
  await advance(5_000);
  await advance(15_000);
  expect(mockGetPostDocuments).toHaveBeenCalledTimes(3);

  // Out of retries: a re-render reporting the same flag asks nothing more.
  requestPendingDocuments('a');
  await advance(60_000);
  expect(mockGetPostDocuments).toHaveBeenCalledTimes(3);
});

it('stops asking for a post the server does not answer for', async () => {
  seed('hidden');
  mockGetPostDocuments.mockResolvedValue({ posts: {} });

  requestPendingDocuments('hidden');
  await advance(1_500);
  await advance(60_000);

  expect(mockGetPostDocuments).toHaveBeenCalledTimes(1);
  expect(mockPosts.get('hidden')?.documentsPending).toBeUndefined();
});

it('retries after a failed call without touching the post', async () => {
  seed('a');
  mockGetPostDocuments
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ posts: { a: { documents: [CARD] } } });

  requestPendingDocuments('a');
  await advance(1_500);
  expect(mockPosts.get('a')?.documentsPending).toBe(true);

  await advance(5_000);
  expect(mockGetPostDocuments).toHaveBeenCalledTimes(2);
  expect(mockPosts.get('a')?.documents).toEqual([CARD]);
});

it('asks for the pending posts the cache stores, including an embedded one, once registered', async () => {
  seed('a');
  seed('quoted');
  mockGetPostDocuments.mockResolvedValue({ posts: { a: { documents: [CARD] }, quoted: { documents: [CARD] } } });
  const unregister = registerPendingDocuments();

  notifyPostsStored([
    { id: 'settled', documents: [CARD] } as unknown as FeedItem,
    { ...mockPosts.get('a'), quotedPost: mockPosts.get('quoted') } as unknown as FeedItem,
  ]);
  await advance(1_500);
  unregister();

  expect(mockGetPostDocuments).toHaveBeenCalledWith(['a', 'quoted']);
  expect(mockPosts.get('quoted')?.documents).toEqual([CARD]);

  // Unregistered: a stored pending post no longer asks.
  seed('later');
  notifyPostsStored([mockPosts.get('later') as FeedItem]);
  await advance(60_000);
  expect(mockGetPostDocuments).toHaveBeenCalledTimes(1);
});
