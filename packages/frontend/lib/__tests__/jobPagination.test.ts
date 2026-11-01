import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { getNextJobApplicationPage, getNextJobPage } from '../jobPagination';

const paths = [
  ['job discovery', getNextJobPage],
  ['applications', getNextJobApplicationPage],
] as const;

describe.each(paths)('%s pagination', (_label, getNextPageParam) => {
  it.each([
    { cursors: ['a', 'a'], expected: [undefined, 'a'] },
    { cursors: ['a', 'b', 'a'], expected: [undefined, 'a', 'b'] },
    { cursors: [''], expected: [undefined] },
    { cursors: [undefined], expected: [undefined] },
  ])('stops at an absent or visited cursor: $cursors', async ({ cursors, expected }) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    let index = 0;
    const queryFn = jest.fn(async (_context: { pageParam: string | undefined }) => ({
      hasMore: true,
      nextCursor: cursors[Math.min(index++, cursors.length - 1)],
    }));
    const observer = new InfiniteQueryObserver(client, {
      queryKey: ['jobs', _label],
      initialPageParam: undefined as string | undefined,
      queryFn,
      getNextPageParam,
    });
    try {
      await observer.refetch();
      let result = observer.getCurrentResult();
      for (let i = 0; i < 5 && result.hasNextPage; i++) result = await observer.fetchNextPage();
      expect(queryFn.mock.calls.map(([{ pageParam }]) => pageParam)).toEqual(expected);
      expect(result.hasNextPage).toBe(false);
    } finally {
      client.clear();
    }
  });
});

it('stops applications when the server says there are no more', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const observer = new InfiniteQueryObserver(client, {
    queryKey: ['job-applications'],
    initialPageParam: undefined as string | undefined,
    queryFn: async () => ({ hasMore: false, nextCursor: 'unused' }),
    getNextPageParam: getNextJobApplicationPage,
  });
  try {
    await observer.refetch();
    expect(observer.getCurrentResult().hasNextPage).toBe(false);
  } finally {
    client.clear();
  }
});
