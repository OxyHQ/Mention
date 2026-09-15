const mockPost = jest.fn();
const mockWarn = jest.fn();

jest.mock('@/utils/api', () => ({
  api: { post: (...args: unknown[]) => mockPost(...args) },
}));

jest.mock('@oxy.so/core/logger', () => ({
  ...jest.requireActual('@oxy.so/core/logger'),
  // Called lazily: the logger is built when the module under test loads, which
  // the hoisted import above makes earlier than this file's own consts.
  createLogger: () => ({
    debug: jest.fn(),
    warn: (...args: unknown[]) => mockWarn(...args),
    error: jest.fn(),
  }),
}));

// Jest must install the transport mock before the module under test loads it.
// eslint-disable-next-line import/first
import { refreshPrivacyLists } from '../privacyService';

describe('refreshPrivacyLists', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPost.mockResolvedValue({ data: undefined });
  });

  it('posts to the viewer-scoped refresh endpoint with no body', async () => {
    await refreshPrivacyLists();
    expect(mockPost).toHaveBeenCalledWith('/privacy/refresh');
  });

  it('swallows a failure — the block itself has already succeeded', async () => {
    mockPost.mockRejectedValue({ message: 'HTTP 503 error', status: 503 });
    await expect(refreshPrivacyLists()).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('Privacy cache refresh failed'),
      expect.objectContaining({ status: 503 }),
    );
  });
});
