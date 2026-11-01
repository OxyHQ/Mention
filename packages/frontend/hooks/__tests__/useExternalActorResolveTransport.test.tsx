import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useExternalActorResolve } from '../useExternalActorResolve';

jest.mock('@/lib/oxyServices', () => {
  const { OxyServices } = jest.requireActual<typeof import('@oxy.so/core')>('@oxy.so/core');
  return {
    oxyServices: new OxyServices({ baseURL: 'https://oxy.example.test', enableRetry: false }),
  };
});

const ok = (handle: string) => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  json: async () => ({ actor: { handle } }),
});

function Probe({ query }: { query: string }) {
  return <>{useExternalActorResolve(query)?.handle ?? 'none'}</>;
}

it('cancels the actual transport and rejects a late answer for an obsolete search', async () => {
  jest.useFakeTimers();
  const originalFetch = global.fetch;
  let finishOld!: (value: ReturnType<typeof ok>) => void;
  const requests: Array<{ handle: string; signal: AbortSignal }> = [];
  global.fetch = jest.fn((url: string | URL | Request, init?: RequestInit) => {
    const handle = new URL(String(url)).searchParams.get('handle') ?? '';
    requests.push({ handle, signal: init?.signal as AbortSignal });
    if (handle.startsWith('@alice')) {
      // Some transports finish even after abort: the late response must not
      // replace the new search or trigger a retry.
      return new Promise((resolve) => {
        finishOld = resolve;
      });
    }
    return Promise.resolve(ok('bob@example.org'));
  }) as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let tree!: TestRenderer.ReactTestRenderer;
  const render = (query: string) => (
    <QueryClientProvider client={client}>
      <Probe query={query} />
    </QueryClientProvider>
  );
  try {
    await act(async () => {
      tree = TestRenderer.create(render('@alice@example.org'));
    });
    await act(async () => jest.advanceTimersByTime(400));
    for (let i = 0; i < 20 && requests.length < 1; i++) await act(async () => {});
    expect(requests).toHaveLength(1);
    expect(requests[0].signal.aborted).toBe(false);

    await act(async () => tree.update(render('@bob@example.org')));
    await act(async () => jest.advanceTimersByTime(400));
    for (let i = 0; i < 20 && requests.length < 2; i++) await act(async () => {});
    expect(requests).toHaveLength(2);
    expect(requests[0].signal.aborted).toBe(true);
    await act(async () => jest.advanceTimersByTime(10));
    expect(tree.toJSON()).toBe('bob@example.org');
    await act(async () => finishOld(ok('alice@example.org')));
    await act(async () => jest.advanceTimersByTime(1000));
    expect(tree.toJSON()).toBe('bob@example.org');
    expect(requests.map((r) => r.handle)).toEqual(['@alice@example.org', '@bob@example.org']);
  } finally {
    await act(async () => tree?.unmount());
    client.clear();
    global.fetch = originalFetch;
    jest.useRealTimers();
  }
});
