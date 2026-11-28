import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppIconBadge } from '../AppIconBadge';

const mockSetBadge = jest.fn((_count: number) => Promise.resolve());
const mockState = {
  auth: {
    isAuthResolved: false,
    isAuthenticated: false,
    user: undefined as { id: string } | undefined,
  },
  unread: 0,
  answered: undefined as number | undefined,
};

jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => mockState.auth }));
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ getQueryData: () => mockState.answered }),
}));
jest.mock('@/hooks/useUnreadCount', () => ({ useUnreadCount: () => mockState.unread }));
jest.mock('@/lib/viewerQueryKeys', () => ({
  viewerQueryKeys: { unreadNotifications: () => ['unread'] },
}));
jest.mock('@/utils/notifications', () => ({
  setAppIconBadge: (count: number) => mockSetBadge(count),
}));

it('mirrors the unread count once known and clears it when signed out', () => {
  let tree!: ReactTestRenderer;
  const render = () =>
    act(() => {
      if (tree) tree.update(<AppIconBadge />);
      else tree = create(<AppIconBadge />);
    });

  render();
  mockState.auth = { isAuthResolved: true, isAuthenticated: true, user: { id: 'viewer' } };
  render();
  expect(mockSetBadge).not.toHaveBeenCalled();

  mockState.answered = 3;
  mockState.unread = 3;
  render();
  expect(mockSetBadge).toHaveBeenLastCalledWith(3);

  // Reading them all brings the badge to zero.
  mockState.answered = 0;
  mockState.unread = 0;
  render();
  expect(mockSetBadge).toHaveBeenLastCalledWith(0);

  mockState.unread = 2;
  render();
  mockState.auth = { isAuthResolved: true, isAuthenticated: false, user: undefined };
  render();
  expect(mockSetBadge).toHaveBeenLastCalledWith(0);
  act(() => tree.unmount());
});
