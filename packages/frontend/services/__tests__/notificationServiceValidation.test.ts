import { notificationService } from '@/services/notificationService';

const mockGet = jest.fn();
jest.mock('@/utils/api', () => ({ authenticatedClient: { get: (...args: unknown[]) => mockGet(...args) } }));
// Jest cannot run `import()`: hand the real validators over synchronously.
jest.mock('@/lib/notificationValidation', () => ({
  loadNotificationValidation: () => Promise.resolve(jest.requireActual('@/types/validation')),
}));
jest.mock('@oxy.so/core/logger', () => ({
  ...jest.requireActual('@oxy.so/core/logger'),
  logger: { warn: jest.fn(), error: jest.fn() },
}));

const valid = {
  _id: 'n1', recipientId: 'viewer', actorId: 'actor', type: 'follow',
  entityId: 'actor', entityType: 'user', read: false, createdAt: '2026-09-28T00:00:00.000Z',
};

describe('notificationService.getNotifications', () => {
  it('returns only contract-valid notifications, parsed once at the boundary', async () => {
    mockGet.mockResolvedValue({
      data: {
        notifications: [valid, { ...valid, _id: 'bad', actorId: 42 }],
        unreadCount: 1,
        hasMore: false,
      },
    });

    const page = await notificationService.getNotifications();

    expect(page.notifications.map((n) => n._id)).toEqual(['n1']);
    expect(page.unreadCount).toBe(1);
  });

  it('keeps an empty page empty', async () => {
    mockGet.mockResolvedValue({ data: {} });
    expect((await notificationService.getNotifications()).notifications).toEqual([]);
  });
});
