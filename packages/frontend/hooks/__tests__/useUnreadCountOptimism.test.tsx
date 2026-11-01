import TestRenderer, { act } from 'react-test-renderer';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  notifyManager,
} from '@tanstack/react-query';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { NOTIFICATION_OPTIMISTIC_KEY } from '../usePendingNotificationOperations';
import { useUnreadCount } from '../useUnreadCount';

let mockEpoch = 1;
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
  useAuth: () => ({ user: { id: 'A' }, canUsePrivateApi: true, oxyServices: mockOxy }),
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
