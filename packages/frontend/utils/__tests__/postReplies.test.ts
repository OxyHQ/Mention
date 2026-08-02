import type { HydratedPostSummary, PostPermissions, ReplyPermission } from '@mention/shared-types';
import { postAcceptsReplies, reportableReplyPermission } from '@/utils/postReplies';

/**
 * The rule two surfaces read — the feed row's action bar and the post detail's
 * pinned composer. Both call this and nothing else, so an answer that is wrong
 * here is wrong on both.
 *
 * The channel case is the one worth pinning: a channel post still takes no
 * replies, but a channel is an Oxy ACCOUNT, so the DTO carries nothing that says
 * "channel" — the refusal reaches the client as the server's own verdict in
 * `permissions.canReply`. A predicate that read only `replyPermission` would
 * offer a reply affordance on every channel post.
 */
/**
 * `metadata` is built here rather than spread in by each case: `PostMetadataState`
 * requires `visibility` and `updatedAt` too, and a partial one would only
 * type-check behind a cast — which is exactly how a test stops describing the
 * shape the code actually receives.
 */
function makePost(
  overrides: Partial<HydratedPostSummary> & {
    replyPermission?: ReplyPermission[];
    canReply?: PostPermissions['canReply'];
  },
): HydratedPostSummary {
  const { replyPermission, canReply, ...rest } = overrides;
  return {
    id: 'post-1',
    metadata: {
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
      visibility: 'public',
      ...(replyPermission ? { replyPermission } : {}),
    },
    ...(canReply === undefined ? {} : { permissions: { canReply } }),
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

  it('refuses whenever the server resolved the viewer out, whatever the permission says', () => {
    // The shape a CHANNEL post arrives in: nothing on the DTO names a channel,
    // and its stated permission can be anything — the server's own verdict is
    // the only thing that carries the refusal.
    expect(postAcceptsReplies(makePost({ canReply: false, replyPermission: ['anyone'] }))).toBe(
      false,
    );
  });

  it('refuses when there is no post at all', () => {
    expect(postAcceptsReplies(null)).toBe(false);
    expect(postAcceptsReplies(undefined)).toBe(false);
  });
});

/**
 * The narrower question the post detail's copy asks. Where `postAcceptsReplies`
 * treats every refusal as interchangeable — an affordance that would fail is
 * hidden either way — this one reports ONLY the author's own setting, because
 * only that is a decision somebody made.
 */
describe('reportableReplyPermission', () => {
  it('passes the author\'s own restriction through', () => {
    expect(reportableReplyPermission(makePost({ replyPermission: ['nobody'] }))).toEqual(['nobody']);
    expect(reportableReplyPermission(makePost({ replyPermission: ['following'] }))).toEqual([
      'following',
    ]);
  });

  it('reports nothing when the viewer was resolved out but the author set nothing', () => {
    // A viewer outside a `followers` audience, and every channel post: there is
    // no author decision to name, so the row says nothing rather than inventing
    // one.
    expect(reportableReplyPermission(makePost({ canReply: false }))).toBeUndefined();
  });

  it('reports nothing for a post that set no permission, or no post at all', () => {
    expect(reportableReplyPermission(makePost({}))).toBeUndefined();
    expect(reportableReplyPermission(null)).toBeUndefined();
    expect(reportableReplyPermission(undefined)).toBeUndefined();
  });
});
