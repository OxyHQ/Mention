import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useRealtimeNotifications } from '@/hooks/useRealtimeNotifications';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

type Handler = (...args: unknown[]) => void;
const mockSockets: { handlers: Map<string, Handler> }[] = [];
jest.mock('socket.io-client', () => ({
  io: () => {
    const handlers = new Map<string, Handler>();
    const socket = {
      connected: false,
      on: (event: string, handler: Handler) => { handlers.set(event, handler); return socket; },
      removeAllListeners: () => handlers.clear(),
      disconnect: () => undefined,
    };
    mockSockets.push({ handlers });
    return socket;
  },
}));

// A validator load the test releases by hand, to hold the first event in flight.
jest.mock('@/lib/notificationValidation', () => {
  const validation = jest.requireActual('@/types/validation');
  let release: () => void = () => undefined;
  const loaded = new Promise((resolve) => { release = () => resolve(validation); });
  return { loadNotificationValidation: () => loaded, releaseForTest: () => release() };
});
const releaseValidators = () =>
  (jest.requireMock('@/lib/notificationValidation') as { releaseForTest: () => void }).releaseForTest();

const mockAuth = { user: { id: 'viewer-1' } as { id: string } | null, isAuthenticated: true, isReady: true, oxyServices: { session: { accessToken: 't' } } };
jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => mockAuth }));
jest.mock('@/config', () => ({ API_URL_SOCKET: 'wss://example.test' }));

const notification = (id: string) => ({
  _id: id, recipientId: 'viewer-1', actorId: 'actor', type: 'follow',
  entityId: 'actor', entityType: 'user', read: false, createdAt: '2026-09-28T00:00:00.000Z',
});

function Bridge() {
  useRealtimeNotifications();
  return null;
}

function seed(client: QueryClient) {
  client.setQueryData(viewerQueryKeys.notifications('viewer-1'), {
    pages: [{ notifications: [], unreadCount: 0, hasMore: false, limit: 20 }],
    pageParams: [undefined],
  });
}

const ids = (client: QueryClient) =>
  (client.getQueryData(viewerQueryKeys.notifications('viewer-1')) as { pages: { notifications: { _id: string }[] }[] })
    .pages[0].notifications.map((n) => n._id);

describe('useRealtimeNotifications', () => {
  it('applies events in arrival order while the validators are still loading', async () => {
    const client = new QueryClient();
    seed(client);
    act(() => { TestRenderer.create(<QueryClientProvider client={client}><Bridge /></QueryClientProvider>); });
    const { handlers } = mockSockets.at(-1)!;

    // Insert, then delete the same notification, both before the load settles:
    // the delete must not land first and leave the insert behind.
    handlers.get('notification')!(notification('n1'));
    handlers.get('notificationDeleted')!('n1');
    handlers.get('notification')!(notification('n2'));
    await act(async () => { releaseValidators(); await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });

    expect(ids(client)).toEqual(['n2']);
  });

  it('drops an event still queued when the socket is replaced', async () => {
    const client = new QueryClient();
    seed(client);
    mockAuth.user = { id: 'viewer-1' };
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(<QueryClientProvider client={client}><Bridge /></QueryClientProvider>); });
    const { handlers } = mockSockets.at(-1)!;
    handlers.get('notification')!(notification('late'));

    // Signed out before the queued insert could apply.
    mockAuth.user = null;
    act(() => renderer.update(<QueryClientProvider client={client}><Bridge /></QueryClientProvider>));
    await act(async () => { releaseValidators(); await new Promise((r) => setTimeout(r, 0)); });

    expect(ids(client)).not.toContain('late');
  });
});
