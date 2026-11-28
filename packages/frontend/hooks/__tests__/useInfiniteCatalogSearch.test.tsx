import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useInfiniteCatalogSearch, type InfiniteCatalogSearch } from '../useInfiniteCatalogSearch';

const mockGet = jest.fn();
jest.mock('@/utils/api', () => ({
  authenticatedClient: { get: (...args: unknown[]) => mockGet(...args) },
}));
jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => ({ user: { id: 'viewer' } }) }));
jest.mock('@oxy.so/bloom/theme', () => ({ useTheme: () => ({ colors: { primary: '#000' } }) }));

let latest: InfiniteCatalogSearch<{ id: string }>;
function Probe({ query, type = 'podcast' }: { query: string; type?: 'song' | 'podcast' }) {
  latest = useInfiniteCatalogSearch(type, query);
  return null;
}

it.each(['song', 'podcast'] as const)(
  'cancels obsolete %s searches, keeps the latest results, and preserves pagination',
  async (type) => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    jest.useFakeTimers();
    mockGet.mockReset();
    const calls: Array<{
      params: Record<string, unknown>;
      signal: AbortSignal;
      resolve: (v: unknown) => void;
    }> = [];
    mockGet.mockImplementation(
      (_path: string, config: { params: Record<string, unknown>; signal: AbortSignal }) =>
        new Promise((resolve) => calls.push({ ...config, resolve })),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = (query: string) => (
      <QueryClientProvider client={client}>
        <Probe query={query} type={type} />
      </QueryClientProvider>
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    try {
      await act(async () => {
        renderer = TestRenderer.create(screen('ambient'));
      });
      await act(async () => {
        jest.advanceTimersByTime(350);
      });
      expect(calls).toHaveLength(1);
      expect(mockGet).toHaveBeenCalledWith(
        'profile/media/search',
        expect.objectContaining({ signal: calls[0].signal }),
      );
      expect(calls[0].params).toEqual({ type, q: 'ambient', offset: 0 });
      expect(calls[0].signal.aborted).toBe(false);
      await act(async () => {
        renderer.update(screen('ambient jazz'));
      });
      await act(async () => {
        jest.advanceTimersByTime(350);
      });
      expect(calls).toHaveLength(2);
      expect(calls[0].signal.aborted).toBe(true);
      expect(calls[1].params).toEqual({ type, q: 'ambient jazz', offset: 0 });
      await act(async () => {
        calls[1].resolve({
          data: { data: [{ id: 'new' }], pagination: { hasMore: true, offset: 0, limit: 20 } },
        });
        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(10);
      });
      await act(async () => {
        calls[0].resolve({
          data: { data: [{ id: 'old' }], pagination: { hasMore: false, offset: 0, limit: 20 } },
        });
        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(10);
      });
      expect(latest.results).toEqual([{ id: 'new' }]);
      await act(async () => {
        latest.loadMore();
      });
      expect(calls).toHaveLength(3);
      expect(calls[2].params).toEqual({ type, q: 'ambient jazz', offset: 20 });
      await act(async () => {
        calls[2].resolve({
          data: { data: [{ id: 'next' }], pagination: { hasMore: false, offset: 20, limit: 20 } },
        });
        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(10);
      });
      expect(latest.results).toEqual([{ id: 'new' }, { id: 'next' }]);
    } finally {
      if (renderer) act(() => renderer.unmount());
      client.clear();
      jest.useRealTimers();
    }
  },
);

it('keeps a shared request alive until its last observer leaves', async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers();
  mockGet.mockReset();
  let signal: AbortSignal | undefined;
  mockGet.mockImplementation((_path: string, config: { signal: AbortSignal }) => {
    signal = config.signal;
    return new Promise(() => {});
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = (first: boolean, second: boolean) => (
    <QueryClientProvider client={client}>
      {first && <Probe query="ambient" />}
      {second && <Probe query="ambient" />}
    </QueryClientProvider>
  );
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(screen(true, true));
    });
    await act(async () => {
      jest.advanceTimersByTime(350);
    });
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    await act(async () => {
      renderer.update(screen(false, true));
    });
    expect(signal?.aborted).toBe(false);
    await act(async () => {
      renderer.update(screen(false, false));
    });
    expect(signal?.aborted).toBe(true);
    expect(mockGet).toHaveBeenCalledTimes(1);
  } finally {
    if (renderer) act(() => renderer.unmount());
    client.clear();
    jest.useRealTimers();
  }
});

it('still surfaces a real search failure', async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers();
  mockGet.mockReset();
  mockGet.mockRejectedValueOnce(new Error('upstream failed'));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={client}>
          <Probe query="ambient" />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(370);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10);
    });
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(latest.isError).toBe(true);
    expect(latest.results).toEqual([]);
  } finally {
    if (renderer) act(() => renderer.unmount());
    client.clear();
    jest.useRealTimers();
  }
});
