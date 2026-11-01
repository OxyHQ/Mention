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
});

describe('publication response confirmation', () => {
  beforeEach(() => jest.clearAllMocks());
  const submissions = [
    [
      'post',
      () => feedService.createPost({ content: { text: 'hi' } } as never),
      { success: true, post: { id: 'p' } },
    ],
    [
      'thread',
      () => feedService.createThread({ posts: [{ content: { text: 'hi' } }] } as never),
      { success: true, posts: [{ id: 'p' }] },
    ],
    [
      'reply',
      () => feedService.createReply({ postId: 'parent', content: { text: 'hi' } }),
      { success: true, reply: { id: 'p' } },
    ],
  ] as const;

  it.each(submissions)('%s accepts a confirmed result', async (_kind, submit, data) => {
    mockAuthenticatedPost.mockResolvedValueOnce({ data });
    await expect(submit()).resolves.toEqual(data);
  });

  it.each(submissions)(
    '%s treats negative and incomplete responses as unconfirmed',
    async (_kind, submit) => {
      for (const data of [
        { success: false },
        undefined,
        { success: true },
        { success: true, post: null, posts: [], reply: null },
        { success: true, post: {}, posts: [{}], reply: {} },
      ]) {
        mockAuthenticatedPost.mockResolvedValueOnce({ data });
        await expect(submit()).rejects.toThrow();
      }
    },
  );

  it('does not treat a partial thread response as confirmation of the whole thread', async () => {
    mockAuthenticatedPost.mockResolvedValueOnce({ data: { success: true, posts: [{ id: 'p' }] } });
    await expect(
      feedService.createThread({
        posts: [{ content: { text: 'one' } }, { content: { text: 'two' } }],
      } as never),
    ).rejects.toThrow();
  });
});
