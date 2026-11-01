import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useExternalActorResolve } from '../useExternalActorResolve';

const mockGet = jest.fn();
jest.mock('@/utils/api', () => ({
  authenticatedClient: { get: (...args: unknown[]) => mockGet(...args) },
  publicClient: { get: jest.fn() },
}));

function Probe({ query }: { query: string }) {
  return <>{useExternalActorResolve(query)?.handle ?? 'none'}</>;
}

beforeEach(() => {
  jest.useFakeTimers();
  mockGet.mockReset();
});
afterEach(() => jest.useRealTimers());

it('aborts obsolete network requests when the query changes and when search unmounts', async () => {
  const signals: AbortSignal[] = [];
  mockGet.mockImplementation((_url: string, config: { signal: AbortSignal }) => {
    signals.push(config.signal);
    return new Promise((_resolve, reject) => {
      config.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(
      <QueryClientProvider client={client}>
        <Probe query="@alice@example.org" />
      </QueryClientProvider>,
    );
  });
  await act(async () => jest.advanceTimersByTime(400));
  expect(mockGet).toHaveBeenCalledWith(
    '/federation/resolve',
    expect.objectContaining({
      params: { handle: '@alice@example.org' },
      signal: expect.any(AbortSignal),
    }),
  );
  expect(signals).toHaveLength(1);
  expect(signals[0].aborted).toBe(false);

  await act(async () => {
    tree.update(
      <QueryClientProvider client={client}>
        <Probe query="@bob@example.org" />
      </QueryClientProvider>,
    );
    jest.advanceTimersByTime(400);
  });
  await act(async () => jest.advanceTimersByTime(400));
  expect(signals).toHaveLength(2);
  expect(signals[0].aborted).toBe(true);
  expect(signals[1].aborted).toBe(false);
  await act(async () => tree.unmount());
  expect(signals[1].aborted).toBe(true);
  client.clear();
});

it('keeps a shared request alive until the last observer leaves', async () => {
  let signal!: AbortSignal;
  mockGet.mockImplementation((_url: string, config: { signal: AbortSignal }) => {
    signal = config.signal;
    return new Promise(() => {});
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const render = (two: boolean) => (
    <QueryClientProvider client={client}>
      <Probe query="@alice@example.org" />
      {two && <Probe query="@alice@example.org" />}
    </QueryClientProvider>
  );
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(render(true));
  });
  await act(async () => jest.advanceTimersByTime(400));
  expect(mockGet).toHaveBeenCalledTimes(1);
  await act(async () => tree.update(render(false)));
  expect(signal.aborted).toBe(false);
  await act(async () => tree.unmount());
  expect(signal.aborted).toBe(true);
  client.clear();
});

it('retains a successful cached result when returning to the same search', async () => {
  mockGet.mockResolvedValue({ data: { actor: { handle: 'alice@example.org' } } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const render = () => (
    <QueryClientProvider client={client}>
      <Probe query="@alice@example.org" />
    </QueryClientProvider>
  );
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(render());
  });
  await act(async () => jest.advanceTimersByTime(400));
  await act(async () => jest.advanceTimersByTime(10));
  expect(tree.toJSON()).toBe('alice@example.org');
  await act(async () => tree.unmount());
  await act(async () => {
    tree = TestRenderer.create(render());
  });
  await act(async () => jest.advanceTimersByTime(400));
  expect(tree.toJSON()).toBe('alice@example.org');
  expect(mockGet).toHaveBeenCalledTimes(1);
  await act(async () => tree.unmount());
  client.clear();
});
