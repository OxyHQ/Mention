import { eventsService } from '../eventsService';
import { authenticatedClient, publicClient } from '@/utils/api';

jest.mock('@/utils/api', () => ({
  authenticatedClient: { get: jest.fn(), put: jest.fn(), post: jest.fn(), delete: jest.fn() },
  publicClient: { get: jest.fn() },
}));
const event = {
  name: 'Meet',
  date: '2099-01-01T12:00:00Z',
  capacity: null,
  postId: 'event/1',
  cancelled: false,
  revision: 2,
  attendingCount: 1,
  viewerAttendance: { public: false },
  canManage: false,
};
beforeEach(() => jest.clearAllMocks());
it('keeps anonymous reads on the public client and private attendance on the authenticated client', async () => {
  jest.mocked(publicClient.get).mockResolvedValue({ data: { ...event, viewerAttendance: null } });
  jest.mocked(authenticatedClient.get).mockResolvedValue({ data: event });
  expect((await eventsService.get('event/1', false)).viewerAttendance).toBeNull();
  expect(publicClient.get).toHaveBeenCalledWith('/posts/event%2F1/event');
  expect(authenticatedClient.get).not.toHaveBeenCalled();
  expect((await eventsService.get('event/1', true)).viewerAttendance).toEqual({ public: false });
});
it('sends explicit private attendance, validates responses and withdraws through the same resource', async () => {
  jest.mocked(authenticatedClient.put).mockResolvedValue({ data: event });
  await eventsService.register('event/1', false);
  expect(authenticatedClient.put).toHaveBeenCalledWith('/posts/event%2F1/event/attendance', {
    public: false,
  });
  await eventsService.withdraw('event/1');
  expect(authenticatedClient.delete).toHaveBeenCalledWith('/posts/event%2F1/event/attendance');
  jest
    .mocked(authenticatedClient.put)
    .mockResolvedValue({ data: { ...event, attendingCount: 'invalid' } });
  await expect(eventsService.register('event/1', true)).rejects.toThrow();
});
it('refuses invalid edits before sending and retains optimistic-concurrency revisions', async () => {
  await expect(
    eventsService.edit('event/1', { name: '', date: event.date, capacity: null, revision: 2 }),
  ).rejects.toThrow();
  expect(authenticatedClient.put).not.toHaveBeenCalled();
  jest.mocked(authenticatedClient.put).mockResolvedValue({ data: event });
  const edit = { name: 'Updated', date: event.date, capacity: 5, revision: 2 };
  await eventsService.edit('event/1', edit);
  expect(authenticatedClient.put).toHaveBeenCalledWith('/posts/event%2F1/event', edit);
  jest.mocked(authenticatedClient.post).mockResolvedValue({ data: { ...event, cancelled: true } });
  expect((await eventsService.cancel('event/1', 2)).cancelled).toBe(true);
  expect(authenticatedClient.post).toHaveBeenCalledWith('/posts/event%2F1/event/cancel', {
    revision: 2,
  });
});
it('encodes roster cursors, preserves organizer scope, and rejects malformed rosters', async () => {
  jest
    .mocked(authenticatedClient.get)
    .mockResolvedValue({
      data: { items: [{ oxyUserId: 'private', public: false }], nextCursor: 'next' },
    });
  expect((await eventsService.attendees('event/1', true, true, 'a+b&x')).items).toHaveLength(1);
  expect(authenticatedClient.get).toHaveBeenCalledWith(
    '/posts/event%2F1/event/attendees?scope=organizers&cursor=a%2Bb%26x',
  );
  jest.mocked(publicClient.get).mockResolvedValue({ data: { items: [], nextCursor: null } });
  await eventsService.attendees('event/1', false, false);
  expect(publicClient.get).toHaveBeenCalledWith('/posts/event%2F1/event/attendees?scope=public');
  jest
    .mocked(publicClient.get)
    .mockResolvedValue({ data: { items: [{ oxyUserId: 'bad' }], nextCursor: null } });
  await expect(eventsService.attendees('event/1', false, false)).rejects.toThrow();
});
