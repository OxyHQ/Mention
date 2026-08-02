// `mock`-prefixed on purpose: jest hoists `jest.mock` above these declarations
// and rejects a factory that closes over anything else.
const mockAuthenticated = {
  get: jest.fn(),
  post: jest.fn(),
  patch: jest.fn(),
  delete: jest.fn(),
};
const mockPublicGet = jest.fn();

jest.mock('@/utils/api', () => ({
  authenticatedClient: {
    get: (...args: unknown[]) => mockAuthenticated.get(...args),
    post: (...args: unknown[]) => mockAuthenticated.post(...args),
    patch: (...args: unknown[]) => mockAuthenticated.patch(...args),
    delete: (...args: unknown[]) => mockAuthenticated.delete(...args),
  },
  publicApi: {
    get: (...args: unknown[]) => mockPublicGet(...args),
  },
}));

import { lanesService } from '@/services/lanesService';

/**
 * The service's job is the wire contract, and the two halves of it that are easy
 * to get wrong silently: WHICH client each read goes out on (a profile's tab
 * list has to work for a signed-out visitor), and the fact that those two clients
 * treat the backend's `{ data }` envelope DIFFERENTLY — the linked client peels
 * it, raw axios does not.
 */
describe('lanesService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads a publisher’s tab list on the PUBLIC client, peeling the envelope itself', async () => {
    // Raw axios: `data` is the whole HTTP body, envelope included.
    mockPublicGet.mockResolvedValue({ data: { data: [{ id: 'lane-1', name: 'dev' }] } });

    const lanes = await lanesService.listForOwner('owner-1');

    expect(mockPublicGet).toHaveBeenCalledWith('/lanes', { ownerType: 'user', ownerId: 'owner-1' });
    expect(mockAuthenticated.get).not.toHaveBeenCalled();
    expect(lanes).toEqual([{ id: 'lane-1', name: 'dev' }]);
  });

  it('defaults an empty list rather than undefined for every collection read', async () => {
    mockPublicGet.mockResolvedValue({ data: undefined });
    mockAuthenticated.get.mockResolvedValue({ data: undefined });

    await expect(lanesService.listForOwner('owner-1')).resolves.toEqual([]);
    await expect(lanesService.listMine()).resolves.toEqual([]);
    await expect(lanesService.listMuted()).resolves.toEqual([]);
  });

  it('sends the caller-scoped reads and writes authenticated', async () => {
    mockAuthenticated.get.mockResolvedValue({ data: [] });
    mockAuthenticated.post.mockResolvedValue({ data: { id: 'lane-1' } });
    mockAuthenticated.patch.mockResolvedValue({ data: { id: 'lane-1' } });
    mockAuthenticated.delete.mockResolvedValue({ data: { success: true } });

    await lanesService.listMine();
    await lanesService.listMuted();
    await lanesService.create({ name: 'dev' });
    await lanesService.update('lane-1', { displayMode: 'tab' });
    await lanesService.remove('lane-1');
    await lanesService.mute('lane-2');
    await lanesService.unmute('lane-2');

    expect(mockAuthenticated.get).toHaveBeenCalledWith('/lanes/mine');
    expect(mockAuthenticated.get).toHaveBeenCalledWith('/lanes/muted');
    expect(mockAuthenticated.post).toHaveBeenCalledWith('/lanes', { name: 'dev' });
    expect(mockAuthenticated.patch).toHaveBeenCalledWith('/lanes/lane-1', { displayMode: 'tab' });
    expect(mockAuthenticated.delete).toHaveBeenCalledWith('/lanes/lane-1');
    expect(mockAuthenticated.post).toHaveBeenCalledWith('/lanes/lane-2/mute');
    expect(mockAuthenticated.delete).toHaveBeenCalledWith('/lanes/lane-2/mute');
    expect(mockPublicGet).not.toHaveBeenCalled();
  });

  it('reads the lane out of the peeled move response', async () => {
    // The linked client already removed the `{ data, message }` envelope, so the
    // payload the service sees is the inner object and nothing else.
    mockAuthenticated.patch.mockResolvedValue({
      data: { postId: 'post-1', lane: { id: 'lane-1', name: 'dev', displayMode: 'tab' } },
    });

    await expect(lanesService.setPostLane('post-1', 'lane-1')).resolves.toEqual({
      id: 'lane-1',
      name: 'dev',
      displayMode: 'tab',
    });
    expect(mockAuthenticated.patch).toHaveBeenCalledWith('/posts/post-1/lane', { laneId: 'lane-1' });
  });

  it('sends an explicit null to take a post off every lane, and reads null back', async () => {
    mockAuthenticated.patch.mockResolvedValue({
      data: { postId: 'post-1', lane: null },
    });

    await expect(lanesService.setPostLane('post-1', null)).resolves.toBeNull();
    expect(mockAuthenticated.patch).toHaveBeenCalledWith('/posts/post-1/lane', { laneId: null });
  });

  it('lets a failed lane write surface — it is not a swallow-and-retry command', async () => {
    mockAuthenticated.patch.mockRejectedValue(new Error('boom'));
    await expect(lanesService.setPostLane('post-1', 'lane-1')).rejects.toThrow('boom');
  });
});
