import TestRenderer, { act } from 'react-test-renderer';
import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchNewestUsersPage } from '@/lib/recommendations';
import { useInfiniteNewestUsers, useInfiniteRecommendations } from '../useRecommendations';

jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual('@tanstack/react-query'),
  useQuery: () => ({ isSuccess: true }),
  useInfiniteQuery: jest.fn(() => ({ data: undefined })),
  keepPreviousData: jest.fn(),
}));
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ user: null, oxyServices: { users: { getMany: jest.fn() } } }),
}));
jest.mock('@/utils/storage', () => ({ Storage: {} }));
jest.mock('@/lib/recommendations', () => ({
  ...jest.requireActual('@/lib/recommendations'),
  fetchNewestUsersPage: jest.fn(async () => ({
    recommendations: [],
    nextCursor: null,
    nextOffset: null,
    hasMore: false,
  })),
}));

it('stops pagination when the server repeats a previous cursor', () => {
  function Probe() {
    useInfiniteRecommendations({ excludeTypes: [] });
    return null;
  }
  let renderer: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<Probe />);
  });
  const options = (useInfiniteQuery as jest.Mock).mock.calls[0][0];
  const next = (cursor: string | null, visited: (string | null)[]) =>
    options.getNextPageParam({ nextCursor: cursor }, [], visited.at(-1), visited);

  expect(next('second', [null, 'first'])).toBe('second');
  expect(next('first', [null, 'first'])).toBeUndefined();
  expect(next('first', [null, 'first', 'second'])).toBeUndefined();
  expect(next(null, [null])).toBeUndefined();
  act(() => renderer.unmount());
});

it('pages the newest people and flattens the pages without repeating anyone', async () => {
  const person = (id: string) => ({ id, name: { displayName: id } });
  (useInfiniteQuery as jest.Mock).mockReturnValueOnce({
    data: {
      pages: [
        { recommendations: [person('a'), person('b')] },
        { recommendations: [person('b'), person('c')] },
      ],
    },
  });
  let result: ReturnType<typeof useInfiniteNewestUsers> | undefined;
  function Probe() {
    result = useInfiniteNewestUsers();
    return null;
  }
  let renderer: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<Probe />);
  });

  expect(result?.recommendations.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  const options = (useInfiniteQuery as jest.Mock).mock.calls.at(-1)[0];
  await options.queryFn({ pageParam: 'cursor-2' });
  expect(fetchNewestUsersPage).toHaveBeenCalledWith({ limit: 20, cursor: 'cursor-2' });
  act(() => renderer.unmount());
});
