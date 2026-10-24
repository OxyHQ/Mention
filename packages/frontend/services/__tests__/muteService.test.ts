import { muteService } from '../muteService';

const mockPost = jest.fn();
const mockDelete = jest.fn();
const mockGet = jest.fn();
const mockNotify = jest.fn();
let mockViewerId: string | undefined = 'viewer-a';
const mockListeners = new Set<() => void>();
jest.mock('@/utils/api', () => ({
  authenticatedClient: {
    post: (...args: unknown[]) => mockPost(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
    get: (...args: unknown[]) => mockGet(...args),
  },
}));
jest.mock('@/stores/feedRankingInvalidation', () => ({
  notifyFeedRankingChanged: (...args: unknown[]) => mockNotify(...args),
}));
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuthStore: {
    getState: () => ({ user: mockViewerId ? { id: mockViewerId } : undefined }),
    subscribe: (listener: () => void) => {
      mockListeners.add(listener);
      return () => mockListeners.delete(listener);
    },
  },
}));
jest.mock('@oxy.so/core/logger', () => ({ createLogger: () => ({ warn: jest.fn() }) }));

beforeEach(() => {
  jest.clearAllMocks();
  mockViewerId = 'viewer-a';
  mockPost.mockResolvedValue({});
  mockDelete.mockResolvedValue({});
  mockListeners.clear();
});

it.each(['muteUser', 'unmuteUser'] as const)(
  '%s notifies only after a successful originating-viewer write',
  async (method) => {
    expect(await muteService[method]('target', 'viewer-a')).toBe(true);
    expect(mockNotify).toHaveBeenCalledWith('viewer-a');
    expect(mockListeners.size).toBe(0);
    const request = method === 'muteUser' ? mockPost : mockDelete;
    request.mockRejectedValueOnce(new Error('write rejected'));
    mockNotify.mockClear();
    expect(await muteService[method]('target', 'viewer-a')).toBe(false);
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockListeners.size).toBe(0);
  },
);

it('refuses an old confirmation after account switch, and an anonymous action', async () => {
  mockViewerId = 'viewer-b';
  expect(await muteService.muteUser('target', 'viewer-a')).toBe(false);
  mockViewerId = undefined;
  expect(await muteService.muteUser('target', undefined)).toBe(false);
  expect(mockPost).not.toHaveBeenCalled();
  expect(mockNotify).not.toHaveBeenCalled();
  expect(mockListeners.size).toBe(0);
});

it('aborts SDK preflight on account change and cannot invalidate the incoming viewer', async () => {
  let finish: (() => void) | undefined;
  mockPost.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const pending = muteService.muteUser('target', 'viewer-a');
  const signal: AbortSignal = mockPost.mock.calls[0][2].signal;
  mockViewerId = 'viewer-b';
  for (const listener of mockListeners) listener();
  expect(signal.aborted).toBe(true);
  if (!finish) throw new Error('Mute was not dispatched');
  // Even a transport that resolves despite cancellation can notify only A.
  finish();
  expect(await pending).toBe(false);
  expect(mockNotify).toHaveBeenCalledWith('viewer-a');
  expect(mockNotify).not.toHaveBeenCalledWith('viewer-b');
  expect(mockListeners.size).toBe(0);
});

it('keeps the existing bounded read and error contracts', async () => {
  mockGet.mockResolvedValueOnce({ data: { mutedUsers: ['target'] } });
  expect(await muteService.getMutedUsers()).toEqual(['target']);
  mockGet.mockResolvedValueOnce({ data: { data: ['other'] } });
  expect(await muteService.getMutedUsers()).toEqual(['other']);
  mockGet.mockResolvedValueOnce({ data: {} });
  expect(await muteService.getMutedUsers()).toEqual([]);
  mockGet.mockRejectedValueOnce(new Error('offline'));
  expect(await muteService.getMutedUsers()).toEqual([]);
  mockGet.mockResolvedValueOnce({ data: { isMuted: true } });
  expect(await muteService.checkMuted('target')).toBe(true);
  mockGet.mockResolvedValueOnce({ data: {} });
  expect(await muteService.checkMuted('target')).toBe(false);
  mockGet.mockRejectedValueOnce(new Error('offline'));
  expect(await muteService.checkMuted('target')).toBe(false);
});
