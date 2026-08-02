// `mock`-prefixed on purpose: jest hoists `jest.mock` above these declarations
// and rejects a factory that closes over anything else.
const mockAuthenticated = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  patch: jest.fn(),
  delete: jest.fn(),
};
const mockPublicGet = jest.fn();

jest.mock('@/utils/api', () => ({
  authenticatedClient: {
    get: (...args: unknown[]) => mockAuthenticated.get(...args),
    post: (...args: unknown[]) => mockAuthenticated.post(...args),
    put: (...args: unknown[]) => mockAuthenticated.put(...args),
    patch: (...args: unknown[]) => mockAuthenticated.patch(...args),
    delete: (...args: unknown[]) => mockAuthenticated.delete(...args),
  },
  publicClient: {
    get: (...args: unknown[]) => mockPublicGet(...args),
  },
}));

import { channelsService } from '@/services/channelsService';

/**
 * What is worth asserting here is the wire contract, and specifically the two
 * halves of it a reader cannot see from a call site:
 *
 *  - WHICH client each read goes out on. A channel page has to render for a
 *    signed-out visitor, and only a signed-in read comes back with `viewerState`.
 *  - The `{ data }` envelope, which the linked client peels and raw axios does
 *    not. Getting that backwards yields a plausible-looking object where a list
 *    was expected, with no error anywhere.
 */
describe('channelsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads the directory anonymously on the PUBLIC client, peeling the envelope itself', async () => {
    mockPublicGet.mockResolvedValue({
      data: { data: { items: [{ id: 'channel-1' }], hasMore: true, nextCursor: '3_channel-1' } },
    });

    const page = await channelsService.listDirectory({ authenticated: false, limit: 20 });

    expect(mockPublicGet).toHaveBeenCalledWith('/channels', { params: { limit: 20 } });
    expect(mockAuthenticated.get).not.toHaveBeenCalled();
    expect(page).toEqual({ items: [{ id: 'channel-1' }], hasMore: true, nextCursor: '3_channel-1' });
  });

  it('excludes already-followed channels for a signed-in reader', async () => {
    mockAuthenticated.get.mockResolvedValue({ data: { items: [], hasMore: false } });

    await channelsService.listDirectory({ authenticated: true, cursor: '3_channel-1' });

    expect(mockAuthenticated.get).toHaveBeenCalledWith('/channels', {
      params: { cursor: '3_channel-1', excludeFollowed: true },
    });
    expect(mockPublicGet).not.toHaveBeenCalled();
  });

  it('reads the subscription list on its own path, keyset-paged, always authenticated', async () => {
    mockAuthenticated.get.mockResolvedValue({
      data: {
        items: [{ id: 'channel-1', viewerState: { isFollowing: true, notify: false } }],
        hasMore: true,
        nextCursor: '1754000000000_follow-1',
      },
    });

    // `/channels/following` is READERSHIP (`ChannelFollow`), a different question
    // from `/channels/mine`, which is publishing rights (`ChannelMember`) — the
    // two are easy to conflate and answer different lists. There is no anonymous
    // form: a subscription list needs a subscriber.
    await expect(
      channelsService.listFollowing({ cursor: '1754000000000_follow-1' }),
    ).resolves.toEqual({
      items: [{ id: 'channel-1', viewerState: { isFollowing: true, notify: false } }],
      hasMore: true,
      nextCursor: '1754000000000_follow-1',
    });

    expect(mockAuthenticated.get).toHaveBeenCalledWith('/channels/following', {
      params: { cursor: '1754000000000_follow-1' },
    });
    expect(mockPublicGet).not.toHaveBeenCalled();
  });

  it('reads one channel by whichever spelling the URL carried', async () => {
    mockAuthenticated.get.mockResolvedValue({ data: { id: 'channel-1', handle: 'dispatch' } });

    await channelsService.get('dispatch', { authenticated: true });

    expect(mockAuthenticated.get).toHaveBeenCalledWith('/channels/dispatch');
  });

  it('defaults an empty collection rather than undefined for every list read', async () => {
    mockPublicGet.mockResolvedValue({ data: { data: undefined } });
    mockAuthenticated.get.mockResolvedValue({ data: undefined });

    await expect(channelsService.listDirectory({ authenticated: false })).resolves.toEqual({
      items: [],
      hasMore: false,
    });
    await expect(channelsService.get('dispatch', { authenticated: false })).resolves.toBeNull();
    await expect(
      channelsService.listMembers('dispatch', { authenticated: false }),
    ).resolves.toEqual([]);
    await expect(channelsService.listMine()).resolves.toEqual([]);
    await expect(channelsService.listInvites()).resolves.toEqual([]);
    await expect(channelsService.listFollowing()).resolves.toEqual({
      items: [],
      hasMore: false,
    });
  });

  it('sends every write authenticated, on the paths the backend actually serves', async () => {
    mockAuthenticated.get.mockResolvedValue({ data: [] });
    mockAuthenticated.post.mockResolvedValue({ data: { id: 'channel-1' } });
    mockAuthenticated.put.mockResolvedValue({ data: { id: 'channel-1' } });
    mockAuthenticated.patch.mockResolvedValue({ data: { notify: false } });
    mockAuthenticated.delete.mockResolvedValue({ data: { success: true } });

    await channelsService.listMine();
    await channelsService.listInvites();
    await channelsService.create({ handle: 'dispatch', title: 'Dispatch' });
    await channelsService.update('channel-1', { title: 'Dispatch Weekly' });
    await channelsService.remove('channel-1');
    await channelsService.invite('channel-1', 'user-2');
    await channelsService.acceptInvite('channel-1');
    await channelsService.declineInvite('channel-1');
    await channelsService.removeMember('channel-1', 'user-2');
    await channelsService.follow('channel-1');
    await channelsService.unfollow('channel-1');

    expect(mockAuthenticated.get).toHaveBeenCalledWith('/channels/mine');
    expect(mockAuthenticated.get).toHaveBeenCalledWith('/channels/invites');
    expect(mockAuthenticated.post).toHaveBeenCalledWith('/channels', {
      handle: 'dispatch',
      title: 'Dispatch',
    });
    expect(mockAuthenticated.put).toHaveBeenCalledWith('/channels/channel-1', {
      title: 'Dispatch Weekly',
    });
    expect(mockAuthenticated.delete).toHaveBeenCalledWith('/channels/channel-1');
    expect(mockAuthenticated.post).toHaveBeenCalledWith('/channels/channel-1/members', {
      oxyUserId: 'user-2',
    });
    expect(mockAuthenticated.post).toHaveBeenCalledWith('/channels/channel-1/members/accept');
    expect(mockAuthenticated.post).toHaveBeenCalledWith('/channels/channel-1/members/decline');
    expect(mockAuthenticated.delete).toHaveBeenCalledWith('/channels/channel-1/members/user-2');
    expect(mockAuthenticated.post).toHaveBeenCalledWith('/channels/channel-1/follow');
    expect(mockAuthenticated.delete).toHaveBeenCalledWith('/channels/channel-1/follow');
    expect(mockPublicGet).not.toHaveBeenCalled();
  });

  it('reads the notification switch back off the server rather than assuming it', async () => {
    // The server is the authority: a `PATCH` against a channel the caller does
    // not follow answers 404, and anything that DOES come back is what the row is.
    mockAuthenticated.patch.mockResolvedValue({ data: { notify: false } });

    await expect(channelsService.setNotify('channel-1', false)).resolves.toBe(false);
    expect(mockAuthenticated.patch).toHaveBeenCalledWith('/channels/channel-1/follow', {
      notify: false,
    });
  });

  it('lets a failed follow surface — a button that quietly does nothing is worse', async () => {
    mockAuthenticated.post.mockRejectedValue(new Error('boom'));
    await expect(channelsService.follow('channel-1')).rejects.toThrow('boom');
  });
});
