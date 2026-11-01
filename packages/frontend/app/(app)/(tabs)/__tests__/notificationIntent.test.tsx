import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  notifyManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import type { NotificationIntent } from '@/types/notificationIntent';

let mockUserId: string | null = 'A';
let mockEpoch = 1;
const mockMarkAll = jest.fn();
const mockConfirm = jest.fn();
const mockMarkAsRead = jest.fn();
const mockDelete = jest.fn();
const mockGetNotifications = jest.fn();
type RowActions = {
  onMarkAsRead: (ids: string[], intent?: NotificationIntent) => void;
  onDelete: (ids: string[], intent?: NotificationIntent) => void;
  captureIntent: () => NotificationIntent | null;
  item: { hasUnread: boolean };
};
const mockRows: Record<string, RowActions> = {};
const mockToast = jest.fn();
const mockAuthListeners = new Set<() => void>();
const mockTokenListeners = new Set<() => void>();
const mockT = (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key;
const mockAuth = {
  oxyServices: {
    users: { getMany: jest.fn() },
    http: { getSessionEpoch: () => mockEpoch },
    session: {
      onChange: (listener: () => void) => {
        mockTokenListeners.add(listener);
        return () => mockTokenListeners.delete(listener);
      },
      get userId() {
        return mockUserId;
      },
      get isAuthenticated() {
        return mockUserId !== null;
      },
    },
  },
  isAuthResolved: true,
  canUsePrivateApi: true,
  isPrivateApiPending: false,
};
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ ...mockAuth, user: { id: mockUserId } }),
  OxyAuthPrompt: () => null,
  useAuthStore: {
    getState: () => ({ user: mockUserId ? { id: mockUserId } : null }),
    subscribe: (listener: () => void) => {
      mockAuthListeners.add(listener);
      return () => mockAuthListeners.delete(listener);
    },
  },
}));
jest.mock('@/services/notificationService', () => ({
  notificationService: {
    getNotifications: (...args: unknown[]) => mockGetNotifications(...args),
    getNotificationsForViewer: (...args: unknown[]) => mockGetNotifications(...args),
    markAsRead: (...args: unknown[]) => mockMarkAsRead(...args),
    deleteNotification: (...args: unknown[]) => mockDelete(...args),
    markAllAsRead: (...args: unknown[]) => mockMarkAll(...args),
    getUnreadCount: jest.fn(),
  },
}));
jest.mock('@/components/notifications/NotificationItem', () => {
  const React = require('react');
  return {
    NotificationItem: React.memo(function MockNotificationItem(
      props: RowActions & { item: { key: string } },
    ) {
      mockRows[props.item.key] = props;
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
      items: { key: string }[];
      renderRow: (item: { key: string }) => React.ReactNode;
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
jest.mock('@oxy.so/bloom/screen', () => {
  const React = require('react');
  return {
    Screen: ({ children, header }: { children: React.ReactNode; header: React.ReactNode }) =>
      React.createElement(React.Fragment, null, header, children),
  };
});
jest.mock('@oxy.so/bloom/page-header', () => ({
  PageHeader: ({ actions }: { actions: React.ReactNode }) => actions,
}));
jest.mock('@oxy.so/bloom/button', () => {
  const React = require('react');
  return { Button: (props: Record<string, unknown>) => React.createElement('button', props) };
});
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
jest.mock('@/hooks/useUnreadCount', () => ({ useUnreadCount: () => 1 }));
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
jest.mock('@/utils/alerts', () => ({
  confirmDialog: (...args: unknown[]) => mockConfirm(...args),
}));
import NotificationsScreen from '../notifications';

function notification(id: string, read = false) {
  return {
    _id: id,
    recipientId: mockUserId ?? '',
    actorId: 'system',
    type: 'welcome',
    entityId: '',
    entityType: 'system',
    read,
    createdAt: '2026-11-01T12:00:00Z',
    actorId_populated: { _id: 'system', username: 'system' },
  };
}
type TestCache = {
  pages: { notifications: ReturnType<typeof notification>[]; unreadCount: number }[];
};
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
function ui() {
  return (
    <QueryClientProvider client={client}>
      <NotificationsScreen />
    </QueryClientProvider>
  );
}
beforeEach(() => {
  mockUserId = 'A';
  mockEpoch = 1;
  mockAuthListeners.clear();
  mockTokenListeners.clear();
  mockMarkAll.mockReset();
  mockConfirm.mockReset();
  for (const key of Object.keys(mockRows)) delete mockRows[key];
  mockMarkAsRead.mockReset();
  mockDelete.mockReset();
  mockGetNotifications.mockReset();
  mockGetNotifications.mockImplementation(async () => ({
    notifications: [notification('one'), notification('two')],
    unreadCount: 2,
    hasMore: false,
    limit: 20,
  }));
  mockToast.mockReset();
  client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false }, mutations: { retry: false } },
  });
  seed(client, 'A', [notification('one'), notification('two')]);
});
afterEach(() => {
  onlineManager.setOnline(true);
  const current = renderer;
  if (current) act(() => current.unmount());
  client.clear();
});

it('keeps a same-viewer offline mutation queued and sends it after reconnecting', async () => {
  onlineManager.setOnline(false);
  mockMarkAsRead.mockResolvedValue(undefined);
  await mount();
  await act(async () => {
    mockRows.one.onMarkAsRead(['one']);
    await tick();
  });
  expect(mockMarkAsRead).not.toHaveBeenCalled();
  await act(async () => {
    onlineManager.setOnline(true);
    await client.resumePausedMutations();
    await tick();
  });
  expect(mockMarkAsRead).toHaveBeenCalledWith('one', 'A');
});

it('does not send a paused A mutation after a viewer transition', async () => {
  onlineManager.setOnline(false);
  mockMarkAsRead.mockResolvedValue(undefined);
  await mount();
  await act(async () => {
    mockRows.one.onMarkAsRead(['one']);
    await tick();
  });
  await switchAwayAndReturn('switch');
  // AccountSwitchReset clears the viewer-scoped query and mutation caches.
  client.clear();
  await act(async () => {
    onlineManager.setOnline(true);
    await client.resumePausedMutations();
    await tick();
  });
  expect(mockMarkAsRead).not.toHaveBeenCalled();
});
async function mount() {
  await act(async () => {
    renderer = TestRenderer.create(ui());
    await tick();
  });
}
function markAllButton() {
  if (!renderer) throw new Error('Screen is not mounted');
  const button = renderer.root.findAll(
    (node) =>
      node.type === 'button' && node.props.accessibilityLabel === 'notification.mark_all_read',
  )[0];
  if (!button) throw new Error('Mark-all button not found');
  return button;
}
async function switchAwayAndReturn(kind: 'switch' | 'aba' | 'logout' | 'relogin') {
  mockEpoch++;
  mockUserId = kind === 'logout' || kind === 'relogin' ? null : 'B';
  const current = renderer;
  if (!current) throw new Error('Screen is not mounted');
  act(() => {
    current.unmount();
  });
  renderer = undefined;
  if (kind === 'aba' || kind === 'relogin') {
    mockEpoch++;
    mockUserId = 'A';
  } else if (kind === 'logout') return;
  if (!mockUserId) throw new Error('Expected a signed-in fixture');
  seed(client, mockUserId, [{ ...notification('new'), recipientId: mockUserId }]);
  await mount();
}
for (const kind of ['switch', 'aba', 'logout', 'relogin'] as const) {
  it(`does not submit A's pending confirmation after ${kind}`, async () => {
    let confirm!: (yes: boolean) => void;
    mockConfirm.mockReturnValue(
      new Promise<boolean>((resolve) => {
        confirm = resolve;
      }),
    );
    await mount();
    await act(async () => {
      markAllButton().props.onPress();
      await tick();
    });
    await switchAwayAndReturn(kind);
    await act(async () => {
      confirm(true);
      await tick();
      await tick();
    });
    expect(mockMarkAll).not.toHaveBeenCalled();
  });
  it(`does not show A's late read error after ${kind}`, async () => {
    const op = deferred();
    mockMarkAsRead.mockReturnValue(op.promise);
    await mount();
    await act(async () => {
      mockRows.one.onMarkAsRead(['one']);
      await tick();
    });
    await switchAwayAndReturn(kind);
    await act(async () => {
      op.reject(Error('late'));
      await tick();
      await tick();
    });
    expect(mockToast).not.toHaveBeenCalled();
  });
  it(`does not show A's late delete success after ${kind}`, async () => {
    const op = deferred();
    mockDelete.mockReturnValue(op.promise);
    await mount();
    await act(async () => {
      mockRows.one.onDelete(['one']);
      await tick();
    });
    await switchAwayAndReturn(kind);
    await act(async () => {
      op.resolve();
      await tick();
      await tick();
    });
    expect(mockToast).not.toHaveBeenCalled();
  });
}
it('aborts the owned confirmation on logout without unmounting the screen', async () => {
  mockConfirm.mockImplementation(
    ({ signal }: { signal: AbortSignal }) =>
      new Promise<boolean>((resolve) => signal.addEventListener('abort', () => resolve(false))),
  );
  await mount();
  await act(async () => {
    markAllButton().props.onPress();
    await tick();
  });
  const signal = (mockConfirm.mock.calls[0][0] as { signal: AbortSignal }).signal;
  expect(signal.aborted).toBe(false);
  await act(async () => {
    mockUserId = null;
    mockEpoch++;
    for (const listener of mockTokenListeners) listener();
    await tick();
  });
  expect(signal.aborted).toBe(true);
  expect(mockMarkAll).not.toHaveBeenCalled();
  expect(mockAuthListeners.size).toBe(0);
  expect(mockTokenListeners.size).toBe(1);
});

for (const change of ['viewer', 'epoch', 'unmount'] as const) {
  it(`aborts the owned confirmation on ${change}`, async () => {
    mockConfirm.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<boolean>((resolve) => signal.addEventListener('abort', () => resolve(false))),
    );
    await mount();
    await act(async () => {
      markAllButton().props.onPress();
      await tick();
    });
    const signal = (mockConfirm.mock.calls[0][0] as { signal: AbortSignal }).signal;
    await act(async () => {
      if (change === 'viewer') {
        mockUserId = 'B';
        for (const listener of mockAuthListeners) listener();
      } else if (change === 'epoch') {
        mockEpoch++;
        for (const listener of mockTokenListeners) listener();
      } else {
        renderer?.unmount();
        renderer = undefined;
      }
      await tick();
    });
    expect(signal.aborted).toBe(true);
    expect(mockMarkAll).not.toHaveBeenCalled();
    expect(mockAuthListeners.size).toBe(0);
    expect(mockTokenListeners.size).toBe(change === 'unmount' ? 0 : 1);
  });
}

it('keeps the confirmation open across a same-session token refresh', async () => {
  let resolve!: (confirmed: boolean) => void;
  mockConfirm.mockReturnValue(
    new Promise<boolean>((done) => {
      resolve = done;
    }),
  );
  mockMarkAll.mockResolvedValue({ message: 'ok' });
  await mount();
  await act(async () => {
    markAllButton().props.onPress();
    await tick();
    for (const listener of mockTokenListeners) listener();
  });
  const signal = (mockConfirm.mock.calls[0][0] as { signal: AbortSignal }).signal;
  expect(signal.aborted).toBe(false);
  await act(async () => {
    resolve(true);
    await tick();
    await tick();
  });
  expect(mockMarkAll).toHaveBeenCalledWith('A');
  expect(mockAuthListeners.size).toBe(0);
  expect(mockTokenListeners.size).toBe(1);
});

it('still submits and reports a successful mark-all for the same session', async () => {
  mockConfirm.mockResolvedValue(true);
  mockMarkAll.mockResolvedValue({ message: 'ok' });
  await mount();
  await act(async () => {
    markAllButton().props.onPress();
    await tick();
    await tick();
    await tick();
  });
  expect(mockMarkAll).toHaveBeenCalledTimes(1);
  expect(mockToast).toHaveBeenCalledWith('notification.mark_all_read_success', { type: 'success' });
});
it('still reports and resynchronizes an ordinary read error', async () => {
  const op = deferred();
  mockMarkAsRead.mockReturnValue(op.promise);
  mockGetNotifications.mockResolvedValue({
    notifications: [notification('one')],
    unreadCount: 1,
    hasMore: false,
    limit: 20,
  });
  await mount();
  await act(async () => {
    mockRows.one.onMarkAsRead(['one']);
    await tick();
  });
  await act(async () => {
    op.reject(Error('network'));
    await tick();
    await tick();
  });
  expect(mockToast).toHaveBeenCalledWith('notification.mark_read_error', { type: 'error' });
  expect(mockGetNotifications).toHaveBeenCalled();
});
it('refuses a stale row action before the previous screen unmounts', async () => {
  await mount();
  mockEpoch++;
  mockUserId = 'B';
  await act(async () => {
    mockRows.one.onMarkAsRead(['one']);
    await tick();
  });
  expect(mockMarkAsRead).not.toHaveBeenCalled();
});

it('sends the viewer captured for the action to the notification service', async () => {
  mockMarkAsRead.mockResolvedValue(undefined);
  await mount();
  await act(async () => {
    mockRows.one.onMarkAsRead(['one']);
    await tick();
    await tick();
  });
  expect(mockMarkAsRead).toHaveBeenCalledWith('one', 'A');
});
it('reverts a rejected viewer mismatch without refetching under the wrong bearer', async () => {
  const op = deferred();
  mockMarkAsRead.mockReturnValue(op.promise);
  client.setQueryData(viewerQueryKeys.unreadNotifications('A'), 2);
  await mount();
  await act(async () => {
    mockRows.one.onMarkAsRead(['one']);
    await tick();
  });
  expect(mockRows.one.item.hasUnread).toBe(false);
  expect(
    client.getQueryData<TestCache>(viewerQueryKeys.notifications('A'))?.pages[0].notifications[0]
      .read,
  ).toBe(false);
  await act(async () => {
    op.reject(Object.assign(new Error('changed'), { code: 'VIEWER_CHANGED', status: 409 }));
    await tick();
    await tick();
  });
  expect(
    client.getQueryData<TestCache>(viewerQueryKeys.notifications('A'))?.pages[0].notifications[0]
      .read,
  ).toBe(false);
  expect(client.getQueryData(viewerQueryKeys.unreadNotifications('A'))).toBe(2);
  expect(mockGetNotifications).not.toHaveBeenCalled();
  expect(mockToast).not.toHaveBeenCalled();
});
it('does not overwrite later cache changes when a viewer mismatch settles', async () => {
  const op = deferred();
  mockMarkAsRead.mockReturnValue(op.promise);
  client.setQueryData(viewerQueryKeys.unreadNotifications('A'), 2);
  await mount();
  await act(async () => {
    mockRows.one.onMarkAsRead(['one']);
    await tick();
  });
  await act(async () => {
    client.setQueryData<TestCache>(
      viewerQueryKeys.notifications('A'),
      (old) =>
        old && {
          ...old,
          pages: old.pages.map((page) => ({ ...page, unreadCount: 99 })),
        },
    );
    client.setQueryData(viewerQueryKeys.unreadNotifications('A'), 1);
    await tick();
  });
  await act(async () => {
    op.reject(Object.assign(new Error('changed'), { code: 'VIEWER_CHANGED', status: 409 }));
    await tick();
    await tick();
  });
  expect(
    client.getQueryData<TestCache>(viewerQueryKeys.notifications('A'))?.pages[0].unreadCount,
  ).toBe(99);
  expect(client.getQueryData(viewerQueryKeys.unreadNotifications('A'))).toBe(1);
});
it('reports and refreshes after an old backend returns 404', async () => {
  const op = deferred();
  mockMarkAsRead.mockReturnValue(op.promise);
  mockGetNotifications.mockResolvedValue({
    notifications: [notification('one')],
    unreadCount: 1,
    hasMore: false,
    limit: 20,
  });
  await mount();
  await act(async () => {
    mockRows.one.onMarkAsRead(['one']);
    await tick();
  });
  await act(async () => {
    op.reject(Object.assign(new Error('not found'), { status: 404 }));
    await tick();
    await tick();
  });
  expect(mockToast).toHaveBeenCalledWith('notification.mark_read_error', { type: 'error' });
  expect(mockGetNotifications).toHaveBeenCalled();
});
for (const kind of ['switch', 'aba', 'logout', 'relogin'] as const) {
  it(`suppresses a late mark-all result after ${kind}`, async () => {
    const op = deferred();
    mockConfirm.mockResolvedValue(true);
    mockMarkAll.mockReturnValue(op.promise);
    await mount();
    await act(async () => {
      markAllButton().props.onPress();
      await tick();
      await tick();
    });
    expect(mockMarkAll).toHaveBeenCalledWith('A');
    await switchAwayAndReturn(kind);
    await act(async () => {
      op.resolve();
      await tick();
      await tick();
    });
    expect(mockToast).not.toHaveBeenCalled();
  });
}
for (const kind of ['switch', 'aba', 'logout', 'relogin'] as const) {
  it(`does not execute an old action menu after ${kind}`, async () => {
    mockDelete.mockResolvedValue(undefined);
    await mount();
    const oldRow = mockRows.one;
    const intent = oldRow.captureIntent();
    if (!intent) throw new Error('Expected an action intent');
    await switchAwayAndReturn(kind);
    await act(async () => {
      oldRow.onDelete(['one'], intent);
      await tick();
      await tick();
    });
    expect(mockDelete).not.toHaveBeenCalled();
  });
}
it('executes an action menu within its original session', async () => {
  mockDelete.mockResolvedValue(undefined);
  await mount();
  const row = mockRows.one;
  const intent = row.captureIntent();
  if (!intent) throw new Error('Expected an action intent');
  await act(async () => {
    row.onDelete(['one'], intent);
    await tick();
    await tick();
  });
  expect(mockDelete).toHaveBeenCalledWith('one', 'A');
});

it('AUDIT: concurrent independent writes preserve a rejected row', async () => {
  const rejected = deferred();
  const accepted = deferred();
  mockMarkAsRead.mockImplementation((id: string) =>
    id === 'one' ? rejected.promise : accepted.promise,
  );
  client.setQueryData(viewerQueryKeys.unreadNotifications('A'), 2);
  await mount();
  await act(async () => {
    mockRows.one.onMarkAsRead(['one']);
    await tick();
    mockRows.two.onMarkAsRead(['two']);
    await tick();
  });
  await act(async () => {
    accepted.resolve();
    await tick();
    rejected.reject(Object.assign(new Error('changed'), { code: 'VIEWER_CHANGED', status: 409 }));
    await tick();
    await tick();
  });
  const list = client.getQueryData<TestCache>(viewerQueryKeys.notifications('A'))?.pages[0]
    .notifications;
  expect(list?.find((row) => row._id === 'one')?.read).toBe(false);
  expect(list?.find((row) => row._id === 'two')?.read).toBe(true);
  expect(client.getQueryData(viewerQueryKeys.unreadNotifications('A'))).toBe(1);
});

it('AUDIT: a partial grouped success is not reverted on viewer mismatch', async () => {
  const rejected = deferred();
  const accepted = deferred();
  mockMarkAsRead.mockImplementation((id: string) =>
    id === 'one' ? rejected.promise : accepted.promise,
  );
  client.setQueryData(viewerQueryKeys.unreadNotifications('A'), 2);
  await mount();
  await act(async () => {
    mockRows.one.onMarkAsRead(['one', 'two']);
    await tick();
  });
  await act(async () => {
    accepted.resolve();
    await tick();
    rejected.reject(Object.assign(new Error('changed'), { code: 'VIEWER_CHANGED', status: 409 }));
    await tick();
    await tick();
  });
  const list = client.getQueryData<TestCache>(viewerQueryKeys.notifications('A'))?.pages[0]
    .notifications;
  expect(list?.find((row) => row._id === 'one')?.read).toBe(false);
  expect(list?.find((row) => row._id === 'two')?.read).toBe(true);
  expect(client.getQueryData(viewerQueryKeys.unreadNotifications('A'))).toBe(1);
});

it('AUDIT: same-viewer epoch replacement restores a paused mutation that is never sent', async () => {
  onlineManager.setOnline(false);
  mockMarkAsRead.mockResolvedValue(undefined);
  client.setQueryData(viewerQueryKeys.unreadNotifications('A'), 2);
  await mount();
  await act(async () => {
    mockRows.one.onMarkAsRead(['one']);
    await tick();
  });
  mockEpoch++;
  await act(async () => {
    onlineManager.setOnline(true);
    await client.resumePausedMutations();
    await tick();
    await tick();
  });
  expect(mockMarkAsRead).not.toHaveBeenCalled();
  const list = client.getQueryData<TestCache>(viewerQueryKeys.notifications('A'))?.pages[0]
    .notifications;
  expect(list?.find((row) => row._id === 'one')?.read).toBe(false);
  expect(client.getQueryData(viewerQueryKeys.unreadNotifications('A'))).toBe(2);
});
