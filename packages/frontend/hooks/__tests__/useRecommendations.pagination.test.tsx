import TestRenderer, { act } from 'react-test-renderer';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useInfiniteRecommendations } from '../useRecommendations';

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
