/**
 * `feedService.createReply` hands back the reply itself.
 *
 * `POST /feed/reply` answers 201 `{ success, reply }` with the reply already
 * hydrated for this viewer. The service used to return the whole body as an
 * untyped `reply`, so nothing could put the new reply into the thread and it
 * stayed invisible until a pull-to-refresh (OxyHQ/Mention#1140).
 */

const mockAuthenticatedPost = jest.fn();

jest.mock('@/utils/api', () => ({
  authenticatedClient: {
    post: (...args: unknown[]) => mockAuthenticatedPost(...args),
  },
  publicClient: {},
  isNotFoundError: () => false,
}));

jest.mock('@/lib/oxyServices', () => ({
  oxyServices: {
    getClient: () => ({ getAccessToken: () => 'token' }),
    getCurrentUserId: () => 'viewer-1',
  },
}));

jest.mock('@oxy.so/core/logger', () => ({
  ...jest.requireActual('@oxy.so/core/logger'),
  logger: { debug: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

// eslint-disable-next-line import/first
import { feedService } from '../feedService';

describe('feedService.createReply', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the hydrated reply from the response body', async () => {
    const reply = { id: 'reply-1', parentPostId: 'parent-1' };
    mockAuthenticatedPost.mockResolvedValue({ data: { success: true, reply } });

    const result = await feedService.createReply({ postId: 'parent-1', content: { text: 'hi' } });

    expect(result).toEqual({ success: true, reply });
    expect(mockAuthenticatedPost).toHaveBeenCalledWith('/feed/reply', {
      postId: 'parent-1',
      content: { text: 'hi' },
      mentions: [],
      hashtags: [],
    });
  });

  it('reports the server’s own success flag, and no reply when it sent none', async () => {
    mockAuthenticatedPost.mockResolvedValue({ data: { success: false } });
    await expect(
      feedService.createReply({ postId: 'parent-1', content: { text: 'hi' } }),
    ).resolves.toEqual({ success: false, reply: null });

    mockAuthenticatedPost.mockResolvedValue({ data: undefined });
    await expect(
      feedService.createReply({ postId: 'parent-1', content: { text: 'hi' } }),
    ).resolves.toEqual({ success: true, reply: null });
  });
});
