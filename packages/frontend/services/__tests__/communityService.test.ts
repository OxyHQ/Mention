/**
 * `communityService` — the community moderation surface's client half: each call
 * names the route the backend serves, and reads the `{ data }` envelope back.
 */

import { authenticatedClient } from '@/utils/api';

import { communityService } from '../communityService';

jest.mock('@/utils/api', () => ({
  authenticatedClient: { get: jest.fn(), post: jest.fn(), delete: jest.fn() },
}));

const client = authenticatedClient as unknown as Record<'get' | 'post' | 'delete', jest.Mock>;

describe('communityService', () => {
  it('names each route and unwraps the envelope', async () => {
    client.get.mockResolvedValueOnce({ data: { data: { communities: [{ id: 'forum-1' }] } } });
    expect(await communityService.joined()).toEqual([{ id: 'forum-1' }]);
    expect(client.get).toHaveBeenLastCalledWith('/communities/joined');

    client.get.mockResolvedValueOnce({ data: { data: { bans: [{ reason: 'spam' }] } } });
    expect(await communityService.bans('forum-1')).toEqual([{ reason: 'spam' }]);
    expect(client.get).toHaveBeenLastCalledWith('/communities/forum-1/bans');

    await communityService.removePost('forum-1', 'post-1', 'off topic');
    expect(client.post).toHaveBeenLastCalledWith('/communities/forum-1/posts/post-1/removal', {
      reason: 'off topic',
    });
    await communityService.ban('forum-1', 'user-1');
    expect(client.post).toHaveBeenLastCalledWith('/communities/forum-1/bans', { userId: 'user-1' });
    await communityService.unban('forum-1', 'user-1');
    expect(client.delete).toHaveBeenLastCalledWith('/communities/forum-1/bans/user-1');

    // An empty or odd response reads as nothing rather than throwing.
    client.get.mockResolvedValueOnce({ data: {} });
    expect(await communityService.joined()).toEqual([]);
  });
});
