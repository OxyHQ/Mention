import TestRenderer from 'react-test-renderer';

import { PushNotificationOpener } from '../PushNotificationOpener';

/**
 * A tapped push does what tapping its inbox row does: marks the notification
 * read, refreshes the inbox, and opens what it is about — or the inbox, for a
 * notification that names no post.
 */

jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ isAuthenticated: true, user: { id: 'viewer' } }),
}));

const mockPush = jest.fn();
jest.mock('@/lib/navigation/router', () => ({ useRouter: () => ({ push: mockPush }) }));

const mockInvalidate = jest.fn();
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidate }),
}));

const mockMarkAsRead = jest.fn();
jest.mock('@/services/notificationService', () => ({
  notificationService: { markAsRead: (id: string) => mockMarkAsRead(id) },
}));

let mockOnOpen: ((data: Record<string, string>) => void) | undefined;
jest.mock('@/utils/notifications', () => ({
  subscribeToPushOpens: async (onOpen: (data: Record<string, string>) => void) => {
    mockOnOpen = onOpen;
    return () => undefined;
  },
}));

it('marks a tapped push read and opens its post, or the inbox when it names none', async () => {
  mockMarkAsRead.mockResolvedValue(undefined);
  await TestRenderer.act(async () => {
    TestRenderer.create(<PushNotificationOpener />);
  });

  await TestRenderer.act(async () => {
    mockOnOpen?.({ notificationId: 'n1', entityType: 'post', entityId: 'p1' });
  });
  expect(mockMarkAsRead).toHaveBeenCalledWith('n1');
  expect(mockInvalidate).toHaveBeenCalled();
  expect(mockPush).toHaveBeenLastCalledWith('/p/p1');

  mockOnOpen?.({ entityType: 'profile', entityId: 'u1' });
  expect(mockPush).toHaveBeenLastCalledWith('/notifications');
});
