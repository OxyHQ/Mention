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

import {
  registerPendingDocuments,
  requestPendingDocuments,
  resetPendingDocuments,
} from '../pendingDocuments';
import { notifyPostsStored } from '@/db/postObservers';

const CARD = {
  id: 'doc-1',
  canonicalUrl: 'https://example.com/a',
  type: 'page',
  status: 'indexed',
  authors: [],
  evidence: {},
};

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
  resetPendingDocuments();
});

afterEach(() => {
  jest.useRealTimers();
});

it('batches every pending post on screen into one call and writes the cards back', async () => {
  seed('a');
  seed('b');
  mockGetPostDocuments.mockResolvedValue({
    posts: { a: { documents: [CARD] }, b: { documents: [CARD] } },
  });

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
  mockGetPostDocuments.mockResolvedValue({
    posts: { a: { documents: [], documentsPending: true } },
  });

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
  mockGetPostDocuments.mockResolvedValue({
    posts: { a: { documents: [CARD] }, quoted: { documents: [CARD] } },
  });
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

it("asks for a new post on its own schedule, not behind a retry's longer wait", async () => {
  seed('a');
  seed('b');
  mockGetPostDocuments
    .mockResolvedValueOnce({ posts: { a: { documents: [], documentsPending: true } } })
    .mockResolvedValue({ posts: { b: { documents: [CARD] } } });

  requestPendingDocuments('a');
  await advance(1_500); // a asked once; its retry is 5s out.
  requestPendingDocuments('b');
  await advance(1_600);

  expect(mockGetPostDocuments).toHaveBeenCalledTimes(2);
  expect(mockGetPostDocuments).toHaveBeenLastCalledWith(['b']);
});

it('gives an edited post a fresh budget', async () => {
  seed('a');
  mockGetPostDocuments.mockResolvedValue({
    posts: { a: { documents: [], documentsPending: true } },
  });

  requestPendingDocuments('a', 'v1');
  await advance(1_500);
  await advance(5_000);
  await advance(15_000);
  expect(mockGetPostDocuments).toHaveBeenCalledTimes(3);

  // Same version: out of retries.
  requestPendingDocuments('a', 'v1');
  await advance(60_000);
  expect(mockGetPostDocuments).toHaveBeenCalledTimes(3);

  // An edit (new version) may have added a link: ask again.
  requestPendingDocuments('a', 'v2');
  await advance(1_500);
  expect(mockGetPostDocuments).toHaveBeenCalledTimes(4);
});

it('drops an answer that lands after the viewer changed', async () => {
  seed('a');
  let answer: (value: unknown) => void = () => {};
  mockGetPostDocuments.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );

  requestPendingDocuments('a');
  await advance(1_500);
  resetPendingDocuments();
  answer({ posts: { a: { documents: [CARD] } } });
  await advance(0);

  expect(mockPosts.get('a')?.documents).toEqual([]);
  expect(mockPosts.get('a')?.documentsPending).toBe(true);
});

it("reads each stored post's version, embedded ones included", async () => {
  const unregister = registerPendingDocuments();
  mockGetPostDocuments.mockResolvedValue({
    posts: {
      a: { documents: [], documentsPending: true },
      q: { documents: [], documentsPending: true },
    },
  });
  seed('a');
  seed('q');
  const store = (version: string) =>
    notifyPostsStored([
      {
        ...mockPosts.get('a'),
        metadata: { updatedAt: version },
        quotedPost: { ...mockPosts.get('q'), metadata: { updatedAt: version } },
      } as unknown as FeedItem,
    ]);

  store('v1');
  await advance(1_500);
  await advance(5_000);
  await advance(15_000);
  expect(mockGetPostDocuments).toHaveBeenCalledTimes(3);

  // A post with no string version still counts as one version.
  notifyPostsStored([{ ...mockPosts.get('a'), metadata: {} } as unknown as FeedItem]);
  await advance(1_500);
  expect(mockGetPostDocuments).toHaveBeenCalledTimes(4);

  store('v2');
  await advance(1_500);
  expect(mockGetPostDocuments).toHaveBeenCalledTimes(5);
  unregister();
});

it('keeps the sooner deadline when a later one is added', async () => {
  seed('a');
  seed('b');
  mockGetPostDocuments.mockResolvedValue({
    posts: { a: { documents: [CARD] }, b: { documents: [CARD] } },
  });

  requestPendingDocuments('a');
  await advance(1_000);
  requestPendingDocuments('b'); // due 1.5s from now, after a's deadline.
  await advance(500);

  expect(mockGetPostDocuments).toHaveBeenCalledTimes(1);
  expect(mockGetPostDocuments).toHaveBeenCalledWith(['a', 'b']);
});
