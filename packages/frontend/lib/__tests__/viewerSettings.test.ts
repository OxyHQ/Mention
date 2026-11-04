/**
 * The viewer's settings are ONE cached read: the appearance and embed stores ask
 * for them at the same moment on a signed-in boot, and a settings page saves
 * from — and into — that same copy instead of reading it again.
 */

const mockGet = jest.fn();
const mockPut = jest.fn();
const mockNotFound = { status: 404 };

jest.mock('@/utils/api', () => ({
  authenticatedClient: {
    get: (...args: unknown[]) => mockGet(...args),
    put: (...args: unknown[]) => mockPut(...args),
  },
  isNotFoundError: (error: unknown) => error === mockNotFound,
}));
jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: jest.fn() }));

import { queryClient } from '@/lib/queryClient';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { fetchViewerSettings, saveViewerSettings } from '../viewerSettings';

describe('viewer settings', () => {
  beforeEach(() => {
    queryClient.clear();
    jest.clearAllMocks();
  });

  it('answers concurrent readers with one request', async () => {
    mockGet.mockResolvedValue({ data: { oxyUserId: 'viewer-1', privacy: { showLikes: true } } });

    const [appearance, embeds] = await Promise.all([
      fetchViewerSettings('viewer-1'),
      fetchViewerSettings('viewer-1'),
    ]);

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith('/profile/settings/me', expect.anything());
    expect(embeds).toBe(appearance);
  });

  it('reads a viewer with no document yet as all defaults', async () => {
    mockGet.mockRejectedValue(mockNotFound);
    await expect(fetchViewerSettings('viewer-1')).resolves.toEqual({});
  });

  it('stores the saved document a write answers with', async () => {
    const saved = { oxyUserId: 'viewer-1', privacy: { hideLikeCounts: true } };
    mockPut.mockResolvedValue({ data: saved });

    await saveViewerSettings('viewer-1', { privacy: { hideLikeCounts: true } });

    expect(mockPut).toHaveBeenCalledWith('/profile/settings', {
      privacy: { hideLikeCounts: true },
    });
    expect(queryClient.getQueryData(viewerQueryKeys.settings('viewer-1'))).toEqual(saved);
    await fetchViewerSettings('viewer-1');
    expect(mockGet).not.toHaveBeenCalled();
  });
});
