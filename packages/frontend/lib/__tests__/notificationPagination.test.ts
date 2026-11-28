import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { getNextNotificationPage } from '../notificationPagination';

describe('notification pagination', () => {
  it.each([
    { cursors: ['a', 'a'], expected: [undefined, 'a'] },
    { cursors: ['a', 'b', 'a'], expected: [undefined, 'a', 'b'] },
    { cursors: [''], expected: [undefined] },
    { cursors: [undefined], expected: [undefined] },
  ])('stops at a missing or visited cursor: $cursors', async ({ cursors, expected }) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    let index = 0;
    const queryFn = jest.fn(async (_context: { pageParam: string | undefined }) => ({
      notifications: [],
      hasMore: true,
      nextCursor: cursors[index++],
    }));
    const observer = new InfiniteQueryObserver(client, {
      queryKey: ['notifications', 'user'],
      initialPageParam: undefined as string | undefined,
      queryFn,
      getNextPageParam: getNextNotificationPage,
    });
    await observer.refetch();
    let result = observer.getCurrentResult();
    for (let i = 0; i < 4 && result.hasNextPage; i++) result = await observer.fetchNextPage();
    expect(queryFn.mock.calls.map(([{ pageParam }]) => pageParam)).toEqual(expected);
    expect(result.hasNextPage).toBe(false);
    client.clear();
  });

  it('does not continue when the server says there are no more notifications', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const observer = new InfiniteQueryObserver(client, {
      queryKey: ['notifications', 'user'],
      initialPageParam: undefined as string | undefined,
      queryFn: async () => ({ notifications: [], hasMore: false, nextCursor: 'unused' }),
      getNextPageParam: getNextNotificationPage,
    });
    await observer.refetch();
    expect(observer.getCurrentResult().hasNextPage).toBe(false);
    client.clear();
  });
});
