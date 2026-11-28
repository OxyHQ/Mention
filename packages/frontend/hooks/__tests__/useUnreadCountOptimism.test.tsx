import TestRenderer, { act } from 'react-test-renderer';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useInfiniteQuery,
  notifyManager,
} from '@tanstack/react-query';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { NOTIFICATION_OPTIMISTIC_KEY } from '../usePendingNotificationOperations';
import { useUnreadCount } from '../useUnreadCount';

let mockEpoch = 1;
let mockViewerId = 'A';
const mockListeners = new Set<() => void>();
const mockOxy = {
  http: { getSessionEpoch: () => mockEpoch },
  session: {
    onChange: (listener: () => void) => {
      mockListeners.add(listener);
      return () => mockListeners.delete(listener);
    },
  },
};
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ user: { id: mockViewerId }, canUsePrivateApi: true, oxyServices: mockOxy }),
}));
jest.mock('@/services/notificationService', () => ({
  notificationService: { getUnreadCountForViewer: jest.fn() },
}));

let begin: (() => void) | undefined;
let resolveWrite: (() => void) | undefined;
let displayed = -1;
function Probe() {
  displayed = useUnreadCount();
  const mutation = useMutation({
    mutationKey: NOTIFICATION_OPTIMISTIC_KEY,
    mutationFn: () =>
      new Promise<void>((resolve) => {
        resolveWrite = resolve;
      }),
    onMutate: () => ({ kind: 'read' as const, ids: ['one'], viewerId: 'A', epoch: 1 }),
  });
  begin = () => mutation.mutate();
  return null;
}
const row = (id: string, read = false) => ({ _id: id, read });
const list = (rows: ReturnType<typeof row>[]) => ({
  pages: [{ notifications: rows, unreadCount: rows.length, hasMore: false, limit: 20 }],
  pageParams: [undefined],
});
let client: QueryClient;
let renderer: TestRenderer.ReactTestRenderer;
beforeAll(() => notifyManager.setScheduler((callback) => callback()));
afterAll(() => notifyManager.setScheduler((callback) => setTimeout(callback, 0)));
beforeEach(() => {
  mockEpoch = 1;
  mockViewerId = 'A';
  mockListeners.clear();
  begin = undefined;
  resolveWrite = undefined;
  displayed = -1;
  client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(viewerQueryKeys.notifications('A'), list([row('one'), row('two')]));
  client.setQueryData(viewerQueryKeys.unreadNotifications('A'), 2);
});
afterEach(() => {
  if (renderer) act(() => renderer.unmount());
  client.clear();
});

it('projects the badge without modifying its authoritative count and keeps new realtime arrivals', async () => {
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  expect(displayed).toBe(2);
  await act(async () => {
    begin?.();
    await Promise.resolve();
  });
  expect(displayed).toBe(1);
  expect(client.getQueryData(viewerQueryKeys.unreadNotifications('A'))).toBe(2);
  await act(async () => {
    client.setQueryData(
      viewerQueryKeys.notifications('A'),
      list([row('new'), row('one'), row('two')]),
    );
    client.setQueryData(viewerQueryKeys.unreadNotifications('A'), 3);
    await Promise.resolve();
  });
  expect(displayed).toBe(2);
  await act(async () => {
    resolveWrite?.();
    await Promise.resolve();
  });
  expect(displayed).toBe(3);
});

it('removes an old pending projection when the same viewer receives a new session epoch', async () => {
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    begin?.();
    await Promise.resolve();
  });
  expect(displayed).toBe(1);
  await act(async () => {
    mockEpoch++;
    for (const listener of mockListeners) listener();
    await Promise.resolve();
  });
  expect(displayed).toBe(2);
});

it('does not create a list query or warn when the list cache is cold', async () => {
  const key = viewerQueryKeys.notifications('A');
  client.removeQueries({ queryKey: key, exact: true });
  const warning = jest.spyOn(console, 'warn');
  try {
    await act(async () => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>,
      );
    });
    expect(displayed).toBe(2);
    expect(client.getQueryCache().find({ queryKey: key, exact: true })).toBeUndefined();
    expect(warning.mock.calls.flat().join(' ')).not.toContain('No queryFn');
  } finally {
    warning.mockRestore();
  }
});

it('preserves the real infinite list fetcher through invalidation and refetch', async () => {
  const key = viewerQueryKeys.notifications('A');
  client.removeQueries({ queryKey: key, exact: true });
  const fetchPage = jest.fn(async () => ({
    notifications: [row('one')],
    unreadCount: 1,
    hasMore: false,
    limit: 20,
  }));
  function ListOwner() {
    useInfiniteQuery({
      queryKey: key,
      queryFn: fetchPage,
      initialPageParam: 0,
      getNextPageParam: () => undefined,
    });
    return null;
  }
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <ListOwner />
        <Probe />
      </QueryClientProvider>,
    );
  });
  expect(fetchPage).toHaveBeenCalledTimes(1);
  expect(client.getQueryCache().find({ queryKey: key, exact: true })?.options.queryFn).toBe(
    fetchPage,
  );
  await act(async () => {
    await client.invalidateQueries({ queryKey: key, exact: true });
  });
  expect(fetchPage).toHaveBeenCalledTimes(2);
  await act(async () => {
    await client.refetchQueries({ queryKey: key, exact: true });
  });
  expect(fetchPage).toHaveBeenCalledTimes(3);
  expect(client.getQueryData(key)).toEqual({
    pages: [{ notifications: [row('one')], unreadCount: 1, hasMore: false, limit: 20 }],
    pageParams: [0],
  });
});

it('switches cache subscriptions without projecting another viewer pending operations', async () => {
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    begin?.();
    await Promise.resolve();
  });
  expect(displayed).toBe(1);
  client.setQueryData(viewerQueryKeys.notifications('B'), list([row('one')]));
  client.setQueryData(viewerQueryKeys.unreadNotifications('B'), 8);
  await act(async () => {
    mockViewerId = 'B';
    renderer.update(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  expect(displayed).toBe(8);
  await act(async () => {
    client.setQueryData(viewerQueryKeys.notifications('A'), list([]));
    client.setQueryData(viewerQueryKeys.unreadNotifications('A'), 99);
  });
  expect(displayed).toBe(8);
  await act(async () => {
    client.setQueryData(viewerQueryKeys.unreadNotifications('B'), 9);
  });
  expect(displayed).toBe(9);
});
