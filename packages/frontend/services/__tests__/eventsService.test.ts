// `mock`-prefixed on purpose: jest hoists `jest.mock` above these declarations
// and rejects a factory that closes over anything else.
const mockAuthenticated = { get: jest.fn(), put: jest.fn(), post: jest.fn(), delete: jest.fn() };
const mockPublicGet = jest.fn();

jest.mock('@/utils/api', () => ({
  authenticatedClient: {
    get: (...args: unknown[]) => mockAuthenticated.get(...args),
    put: (...args: unknown[]) => mockAuthenticated.put(...args),
    post: (...args: unknown[]) => mockAuthenticated.post(...args),
    delete: (...args: unknown[]) => mockAuthenticated.delete(...args),
  },
  publicClient: { get: (...args: unknown[]) => mockPublicGet(...args) },
}));

import { eventsService } from '@/services/eventsService';

/**
 * The wire contract: a signed-out reader goes out on the public client, every
 * command on the authenticated one, and the post id is path-encoded.
 */
describe('eventsService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reads on the client that matches the viewer', async () => {
    mockPublicGet.mockResolvedValue({ data: { postId: 'a/b' } });
    mockAuthenticated.get.mockResolvedValue({ data: { postId: 'a/b', canManage: true } });
    expect(await eventsService.get('a/b', false)).toEqual({ postId: 'a/b' });
    expect(mockPublicGet).toHaveBeenCalledWith('/posts/a%2Fb/event');
    expect(await eventsService.get('a/b', true)).toEqual({ postId: 'a/b', canManage: true });
    expect(mockAuthenticated.get).toHaveBeenCalledWith('/posts/a%2Fb/event');
  });

  it('sends each command to its route', async () => {
    mockAuthenticated.put.mockResolvedValue({ data: { revision: 1 } });
    mockAuthenticated.post.mockResolvedValue({ data: { cancelled: true } });
    await eventsService.register('e1', true);
    expect(mockAuthenticated.put).toHaveBeenCalledWith('/posts/e1/event/attendance', {
      public: true,
    });
    await eventsService.withdraw('e1');
    expect(mockAuthenticated.delete).toHaveBeenCalledWith('/posts/e1/event/attendance');
    expect(await eventsService.cancel('e1', 3)).toEqual({ cancelled: true });
    expect(mockAuthenticated.post).toHaveBeenCalledWith('/posts/e1/event/cancel', { revision: 3 });
  });

  it('pages the roster with the scope the viewer may read', async () => {
    mockPublicGet.mockResolvedValue({ data: { items: [], nextCursor: null } });
    await eventsService.attendees('e1', false, false, 'next');
    expect(mockPublicGet).toHaveBeenCalledWith(
      '/posts/e1/event/attendees?scope=public&cursor=next',
    );
  });
});
