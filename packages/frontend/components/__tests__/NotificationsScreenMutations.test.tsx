import type React from 'react';
import type { NotificationListItem } from '@/utils/groupNotifications';
import type { NotificationsInfiniteData } from '@/utils/notificationCache';
import type { TRawNotification } from '@/types/validation';
import TestRenderer, { act } from 'react-test-renderer';
import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

let mockUserId = 'A';
const mockMarkAsRead = jest.fn();
const mockDelete = jest.fn();
const mockGetNotifications = jest.fn();
const mockRows: Record<
  string,
  { onMarkAsRead: (ids: string[]) => void; onDelete: (ids: string[]) => void }
> = {};
const mockRenders: string[] = [];
const mockToast = jest.fn();
const mockT = (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key;
const mockAuth = {
  oxyServices: {
    users: { getMany: jest.fn() },
    http: { getSessionEpoch: () => 1 },
    session: { isAuthenticated: true },
  },
  isAuthResolved: true,
  canUsePrivateApi: true,
  isPrivateApiPending: false,
};
jest.mock('@oxy.so/core/logger', () => ({ createLogger: () => ({ error: jest.fn() }) }));
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ ...mockAuth, user: { id: mockUserId } }),
  OxyAuthPrompt: () => null,
  useAuthStore: { getState: () => ({ user: { id: mockUserId } }) },
}));
jest.mock('@/services/notificationService', () => ({
  notificationService: {
    getNotifications: (...args: unknown[]) => mockGetNotifications(...args),
    markAsRead: (...args: unknown[]) => mockMarkAsRead(...args),
    deleteNotification: (...args: unknown[]) => mockDelete(...args),
    markAllAsRead: jest.fn(),
    getUnreadCount: jest.fn(),
  },
}));
jest.mock('@/components/notifications/NotificationItem', () => {
  const React = require('react');
  return {
    NotificationItem: React.memo(function MockNotificationItem(props: {
      item: { key: string };
      onMarkAsRead: (ids: string[]) => void;
      onDelete: (ids: string[]) => void;
    }) {
      mockRows[props.item.key] = props;
      mockRenders.push(props.item.key);
      return null;
    }),
  };
});
jest.mock('@/components/NotificationsList', () => {
  const React = require('react');
  return {
    NotificationsList: ({
      items,
      renderRow,
    }: {
      items: NotificationListItem[];
      renderRow: (item: NotificationListItem) => React.ReactElement;
    }) =>
      React.createElement(
        React.Fragment,
        null,
        items.map((item) =>
          React.createElement(React.Fragment, { key: item.key }, renderRow(item)),
        ),
      ),
  };
});
jest.mock('@oxy.so/bloom/error-boundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@oxy.so/bloom/screen', () => ({
  Screen: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@oxy.so/bloom/page-header', () => ({ PageHeader: () => null }));
jest.mock('@oxy.so/bloom/button', () => ({ Button: () => null }));
jest.mock('@oxy.so/bloom/tabs', () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => children,
  TabsTrigger: () => null,
}));
jest.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({ colors: { border: '', primary: '', textSecondary: '' } }),
}));
jest.mock('@oxy.so/bloom/toast', () => ({ toast: (...args: unknown[]) => mockToast(...args) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: mockT }) }));
jest.mock('@/lib/navigation/router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@/hooks/useUnreadCount', () => ({ useUnreadCount: () => 0 }));
jest.mock('@/hooks/useNotificationFilter', () => ({
  useNotificationFilter: () => ({ activeTab: 'all', selectTab: jest.fn() }),
}));
jest.mock('@/components/SEO', () => ({ SEO: () => null }));
jest.mock('@/components/notifications/NotificationSkeleton', () => ({
  NotificationSkeleton: () => null,
}));
jest.mock('@/components/common/EmptyState', () => ({ EmptyState: () => null }));
jest.mock('@/components/Error', () => ({ Error: () => null }));
jest.mock('@/utils/userEnrichment', () => ({ prewarmUsersByIds: jest.fn() }));
jest.mock('@/components/settings/settingsRoutes', () => ({ requestSettings: jest.fn() }));
import NotificationsScreen from '@/app/(app)/(tabs)/notifications';
import { prependNotification } from '@/utils/notificationCache';

function notification(id: string, read = false) {
  return {
    _id: id,
    recipientId: mockUserId,
    actorId: 'system',
    type: 'welcome',
    entityId: '',
    entityType: 'system',
    read,
    createdAt: '2026-11-01T12:00:00Z',
    actorId_populated: { _id: 'system', username: 'system' },
  };
}
function seed(client: QueryClient, userId: string, rows: ReturnType<typeof notification>[]) {
  client.setQueryData(viewerQueryKeys.notifications(userId), {
    pages: [
      {
        notifications: rows,
        unreadCount: rows.filter((n) => !n.read).length,
        hasMore: false,
        limit: 20,
      },
    ],
    pageParams: [undefined],
  });
}
beforeAll(() => {
  notifyManager.setScheduler((callback) => callback());
});
afterAll(() => {
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
});
const tick = async () => {
  await Promise.resolve();
};
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
let client: QueryClient;
let renderer: TestRenderer.ReactTestRenderer | undefined;
function mounted() {
  if (!renderer) throw new Error('Screen is not mounted');
  return renderer;
}
function notificationsFor(userId: string): NotificationsInfiniteData {
  const data = client.getQueryData<NotificationsInfiniteData>(
    viewerQueryKeys.notifications(userId),
  );
  if (!data) throw new Error('Missing notification data');
  return data;
}
function whenCurrentMutationSettles(): Promise<void> {
  const cache = client.getMutationCache();
  const mutation = cache.getAll().at(-1);
  if (mutation?.state.status !== 'pending') {
    throw new Error('Expected a pending mutation');
  }
  return new Promise((resolve) => {
    const unsubscribe = cache.subscribe(() => {
      if (mutation.state.status !== 'pending') {
        unsubscribe();
        resolve();
      }
    });
  });
}
function ui() {
  return (
    <QueryClientProvider client={client}>
      <NotificationsScreen />
    </QueryClientProvider>
  );
}
beforeEach(() => {
  mockUserId = 'A';
  mockRenders.length = 0;
  for (const key of Object.keys(mockRows)) delete mockRows[key];
  mockMarkAsRead.mockReset();
  mockDelete.mockReset();
  mockGetNotifications.mockReset();
  mockToast.mockReset();
  client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false }, mutations: { retry: false } },
  });
  seed(client, 'A', [notification('one'), notification('two')]);
});
afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  client.clear();
});
it('does not rerender unchanged rows when read mutation settles', async () => {
  const op = deferred();
  mockMarkAsRead.mockReturnValue(op.promise);
  await act(async () => {
    renderer = TestRenderer.create(ui());
    await tick();
  });
  await act(async () => {
    mockRows.one.onMarkAsRead(['one']);
    await tick();
  });
  mockRenders.length = 0;
  const settled = whenCurrentMutationSettles();
  await act(async () => {
    op.resolve();
    await settled;
  });
  expect(mockRenders).toEqual([]);
  expect(mockMarkAsRead).toHaveBeenCalledWith('one', 'A');
});

it('keeps callbacks current when the viewer changes A → B → A', async () => {
  const op = deferred();
  mockMarkAsRead.mockReturnValueOnce(op.promise).mockResolvedValue(undefined);
  seed(client, 'B', [{ ...notification('b'), recipientId: 'B' }]);
  await act(async () => {
    renderer = TestRenderer.create(ui());
    await tick();
  });
  await act(async () => {
    mockRows.one.onMarkAsRead(['one']);
    await tick();
  });
  const oldSettled = whenCurrentMutationSettles();
  mockUserId = 'B';
  await act(async () => {
    mounted().update(ui());
    await tick();
  });
  await act(async () => {
    mockRows.b.onMarkAsRead(['b']);
    await tick();
  });
  expect(notificationsFor('B').pages[0].notifications[0].read).toBe(true);
  mockUserId = 'A';
  await act(async () => {
    mounted().update(ui());
    await tick();
  });
  await act(async () => {
    op.resolve();
    await oldSettled;
  });
  expect(notificationsFor('B').pages[0].notifications[0].read).toBe(true);
  expect(mockMarkAsRead.mock.calls).toEqual([
    ['one', 'A'],
    ['b', 'B'],
  ]);
});
it('resynchronizes the list and reports a failed read', async () => {
  const op = deferred();
  mockMarkAsRead.mockReturnValue(op.promise);
  mockGetNotifications.mockResolvedValue({
    notifications: [notification('one'), notification('two')],
    unreadCount: 2,
    hasMore: false,
    limit: 20,
  });
  await act(async () => {
    renderer = TestRenderer.create(ui());
    await tick();
  });
  await act(async () => {
    mockRows.one.onMarkAsRead(['one']);
    await tick();
  });
  expect(notificationsFor('A').pages[0].notifications[0].read).toBe(true);
  const settled = whenCurrentMutationSettles();
  await act(async () => {
    op.reject(Error('network'));
    await settled;
  });
  expect(notificationsFor('A').pages[0].notifications[0].read).toBe(false);
  expect(mockToast).toHaveBeenCalled();
  expect(mockGetNotifications).toHaveBeenCalled();
});
it('still renders incoming realtime cache updates after a successful deletion', async () => {
  const op = deferred();
  mockDelete.mockReturnValue(op.promise);
  await act(async () => {
    renderer = TestRenderer.create(ui());
    await tick();
  });
  await act(async () => {
    mockRows.one.onDelete(['one']);
    await tick();
  });
  const settled = whenCurrentMutationSettles();
  await act(async () => {
    op.resolve();
    await settled;
  });
  expect(mockDelete).toHaveBeenCalledWith('one', 'A');
  expect(mockToast).toHaveBeenCalled();
  await act(async () => {
    client.setQueryData<NotificationsInfiniteData>(viewerQueryKeys.notifications('A'), (data) =>
      data ? prependNotification(data, notification('new') as unknown as TRawNotification) : data,
    );
    await tick();
  });
  expect(mockRows.new).toBeDefined();
  expect(notificationsFor('A').pages[0].notifications.map((n) => n._id)).toEqual(['new', 'two']);
});
it('settles a pending mutation after unmount without altering another viewer', async () => {
  const op = deferred();
  mockMarkAsRead.mockReturnValue(op.promise);
  seed(client, 'B', [{ ...notification('b'), recipientId: 'B' }]);
  await act(async () => {
    renderer = TestRenderer.create(ui());
    await tick();
  });
  await act(async () => {
    mockRows.one.onMarkAsRead(['one']);
    await tick();
  });
  act(() => renderer?.unmount());
  renderer = undefined;
  const settled = whenCurrentMutationSettles();
  await act(async () => {
    op.resolve();
    await settled;
  });
  expect(notificationsFor('B').pages[0].notifications[0].read).toBe(false);
});

it('does not rerender unchanged rows when deletion settles', async () => {
  const op = deferred();
  mockDelete.mockReturnValue(op.promise);
  await act(async () => {
    renderer = TestRenderer.create(ui());
    await tick();
  });
  await act(async () => {
    mockRows.one.onDelete(['one']);
    await tick();
  });
  mockRenders.length = 0;
  const settled = whenCurrentMutationSettles();
  await act(async () => {
    op.resolve();
    await settled;
  });
  expect(mockRenders).toEqual([]);
  expect(notificationsFor('A').pages[0].notifications.map((n) => n._id)).toEqual(['two']);
});

it('resynchronizes the list after a failed deletion', async () => {
  const op = deferred();
  mockDelete.mockReturnValue(op.promise);
  mockGetNotifications.mockResolvedValue({
    notifications: [notification('one'), notification('two')],
    unreadCount: 2,
    hasMore: false,
    limit: 20,
  });
  await act(async () => {
    renderer = TestRenderer.create(ui());
    await tick();
  });
  await act(async () => {
    mockRows.one.onDelete(['one']);
    await tick();
  });
  expect(notificationsFor('A').pages[0].notifications.map((n) => n._id)).toEqual(['two']);
  const settled = whenCurrentMutationSettles();
  await act(async () => {
    op.reject(Error('network'));
    await settled;
  });
  expect(notificationsFor('A').pages[0].notifications.map((n) => n._id)).toEqual(['one', 'two']);
  expect(mockToast).toHaveBeenCalled();
  expect(mockGetNotifications).toHaveBeenCalled();
});
