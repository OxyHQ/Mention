const mockPatch = jest.fn();
const mockDelete = jest.fn();
jest.mock('@/utils/api', () => ({
  authenticatedClient: {
    patch: (...args: unknown[]) => mockPatch(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));
import { notificationService } from '../notificationService';

beforeEach(() => {
  mockPatch.mockReset();
  mockDelete.mockReset();
});

it('sends the intended viewer on all new notification write routes', async () => {
  mockPatch.mockResolvedValue({ data: {} });
  mockDelete.mockResolvedValue({ data: {} });
  await notificationService.markAsRead('n', 'A');
  await notificationService.markAllAsRead('A');
  await notificationService.archiveNotification('n', 'A');
  await notificationService.deleteNotification('n', 'A');
  const config = { headers: { 'X-Mention-Expected-Viewer': 'A' } };
  expect(mockPatch.mock.calls).toEqual([
    ['/notifications/_viewer/n/read', undefined, config],
    ['/notifications/_viewer/read-all', undefined, config],
    ['/notifications/_viewer/n/archive', undefined, config],
  ]);
  expect(mockDelete.mock.calls).toEqual([['/notifications/_viewer/n', config]]);
});

it('does not retry an older route when a deployment returns 404', async () => {
  const unavailable = Object.assign(new Error('not found'), { status: 404 });
  mockPatch.mockRejectedValue(unavailable);
  await expect(notificationService.markAllAsRead('A')).rejects.toBe(unavailable);
  expect(mockPatch).toHaveBeenCalledTimes(1);
  expect(mockPatch.mock.calls[0][0]).toBe('/notifications/_viewer/read-all');
});
