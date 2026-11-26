import TestRenderer from 'react-test-renderer';
import { signInAs, signOutForTests } from '@/test-support/accountScope';
import { PushNotificationOpener } from '../PushNotificationOpener';

let mockUserId: string | null = 'viewer';
/** The rendered viewer (`useAuth`) and the signed-in account (the scope), moved together as on device. */
function setViewer(id: string | null) {
  mockUserId = id;
  signInAs(id);
}
let mockEpoch = 1;
const mockOxy = { http: { getSessionEpoch: () => mockEpoch } };
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({
    isAuthenticated: mockUserId !== null,
    user: mockUserId ? { id: mockUserId } : null,
    oxyServices: mockOxy,
  }),
}));
const mockPush = jest.fn();
jest.mock('@/lib/navigation/router', () => ({ useRouter: () => ({ push: mockPush }) }));
const mockInvalidate = jest.fn();
jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual('@tanstack/react-query'),
  useQueryClient: () => ({ invalidateQueries: mockInvalidate }),
}));
const mockMarkAsRead = jest.fn();
jest.mock('@/services/notificationService', () => ({
  notificationService: { markAsRead: (...args: unknown[]) => mockMarkAsRead(...args) },
}));
let mockOnOpen: ((data: Record<string, string>) => void) | undefined;
let mockColdOpen: Record<string, string> | undefined;
jest.mock('@/utils/notifications', () => ({
  subscribeToPushOpens: async (onOpen: (data: Record<string, string>) => void) => {
    mockOnOpen = onOpen;
    if (mockColdOpen) {
      const data = mockColdOpen;
      mockColdOpen = undefined;
      onOpen(data);
    }
    return () => undefined;
  },
}));
let renderer: TestRenderer.ReactTestRenderer;
beforeEach(() => {
  jest.clearAllMocks();
  setViewer('viewer');
  mockEpoch = 1;
  mockOnOpen = undefined;
  mockColdOpen = undefined;
  mockMarkAsRead.mockResolvedValue(undefined);
});
afterEach(() => {
  if (renderer) TestRenderer.act(() => renderer.unmount());
  signOutForTests();
});
async function mount() {
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(<PushNotificationOpener />);
  });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('marks the push for its intended viewer and opens the post or inbox', async () => {
  await mount();
  await TestRenderer.act(async () => {
    mockOnOpen?.({ notificationId: 'n1', entityType: 'post', entityId: 'p1' });
  });
  expect(mockMarkAsRead).toHaveBeenCalledWith('n1', 'viewer');
  expect(mockInvalidate).toHaveBeenCalled();
  expect(mockPush).toHaveBeenLastCalledWith('/p/p1');
  mockOnOpen?.({ entityType: 'profile', entityId: 'u1' });
  expect(mockPush).toHaveBeenLastCalledWith('/notifications');
});

it('waits for a restored viewer before consuming a cold-start push', async () => {
  setViewer(null);
  mockColdOpen = { notificationId: 'n1', entityType: 'post', entityId: 'p1' };
  await mount();
  expect(mockOnOpen).toBeUndefined();
  expect(mockMarkAsRead).not.toHaveBeenCalled();
  expect(mockPush).not.toHaveBeenCalled();
  setViewer('viewer');
  await TestRenderer.act(async () => {
    renderer.update(<PushNotificationOpener />);
  });
  expect(mockMarkAsRead).toHaveBeenCalledWith('n1', 'viewer');
  expect(mockPush).toHaveBeenCalledWith('/p/p1');
});

for (const transition of ['switch', 'aba', 'logout', 'relogin'] as const) {
  it(`does not invalidate an old viewer after ${transition}`, async () => {
    const pending = deferred();
    mockMarkAsRead.mockReturnValue(pending.promise);
    await mount();
    await TestRenderer.act(async () => {
      mockOnOpen?.({ notificationId: 'n1', entityType: 'post', entityId: 'p1' });
    });
    expect(mockPush).toHaveBeenCalledWith('/p/p1');
    mockEpoch++;
    setViewer(transition === 'logout' || transition === 'relogin' ? null : 'other');
    if (transition === 'aba' || transition === 'relogin') {
      mockEpoch++;
      setViewer('viewer');
    }
    await TestRenderer.act(async () => {
      pending.resolve();
      await Promise.resolve();
    });
    expect(mockInvalidate).not.toHaveBeenCalled();
  });
}

it('opens the destination without marking if an old listener fires after a switch', async () => {
  await mount();
  const oldListener = mockOnOpen;
  setViewer('other');
  mockEpoch++;
  await TestRenderer.act(async () => {
    oldListener?.({ notificationId: 'n1', entityType: 'post', entityId: 'p1' });
  });
  expect(mockMarkAsRead).not.toHaveBeenCalled();
  expect(mockPush).toHaveBeenCalledWith('/p/p1');
});

it('does not let a disposed A listener mark a push after A→B→A', async () => {
  await mount();
  const oldListener = mockOnOpen;
  setViewer('other');
  mockEpoch++;
  await TestRenderer.act(async () => {
    renderer.update(<PushNotificationOpener />);
  });
  setViewer('viewer');
  mockEpoch++;
  await TestRenderer.act(async () => {
    renderer.update(<PushNotificationOpener />);
  });
  await TestRenderer.act(async () => {
    oldListener?.({ notificationId: 'n1', entityType: 'post', entityId: 'p1' });
  });
  expect(mockMarkAsRead).not.toHaveBeenCalled();
  expect(mockPush).toHaveBeenCalledWith('/p/p1');
  await TestRenderer.act(async () => {
    mockOnOpen?.({ notificationId: 'n2', entityType: 'post', entityId: 'p2' });
  });
  expect(mockMarkAsRead).toHaveBeenCalledWith('n2', 'viewer');
});
