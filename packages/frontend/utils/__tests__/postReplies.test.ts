import type { HydratedPostSummary, ReplyPermission } from '@mention/shared-types';
import { postAcceptsReplies } from '@/utils/postReplies';

/**
 * The rule two surfaces read — the feed row's action bar and the post detail's
 * pinned composer. Both call this and nothing else, so an answer that is wrong
 * here is wrong on both, and the channel case is the one that must not be
 * expressible through `replyPermission`: the server keys its refusal off the
 * post's channel precisely because a later settings write can change that field.
 */
/**
 * `metadata` is built here rather than spread in by each case: `PostMetadataState`
 * requires `visibility` and `updatedAt` too, and a partial one would only
 * type-check behind a cast — which is exactly how a test stops describing the
 * shape the code actually receives.
 */
function makePost(
  overrides: Partial<HydratedPostSummary> & { replyPermission?: ReplyPermission[] },
): HydratedPostSummary {
  const { replyPermission, ...rest } = overrides;
  return {
    id: 'post-1',
    metadata: {
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
      visibility: 'public',
      ...(replyPermission ? { replyPermission } : {}),
    },
    ...rest,
  } as HydratedPostSummary;
}

describe('postAcceptsReplies', () => {
  it('accepts an ordinary post', () => {
    expect(postAcceptsReplies(makePost({}))).toBe(true);
  });

  it('accepts a post whose author allows anyone', () => {
    expect(postAcceptsReplies(makePost({ replyPermission: ['anyone'] }))).toBe(true);
  });

  it('refuses a post closed to everybody', () => {
    expect(postAcceptsReplies(makePost({ replyPermission: ['nobody'] }))).toBe(false);
  });

  it('refuses a CHANNEL post whatever its reply permission says', () => {
    expect(
      postAcceptsReplies(
        makePost({
          channel: { id: 'channel-1', handle: 'news', title: 'News', signPosts: false },
          replyPermission: ['anyone'],
        }),
      ),
    ).toBe(false);
  });

  it('refuses when there is no post at all', () => {
    expect(postAcceptsReplies(null)).toBe(false);
    expect(postAcceptsReplies(undefined)).toBe(false);
  });
});
