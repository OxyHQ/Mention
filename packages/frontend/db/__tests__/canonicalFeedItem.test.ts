import type { HydratedPost, HydratedPostSummary } from '@mention/shared-types';
import { PostVisibility } from '@mention/shared-types/post';
import { toFeedItem } from '../feedItem';
import { postToRow, rowToFeedItem } from '../schema';

function makePost(
  id: string,
  overrides: Partial<HydratedPost> = {},
): HydratedPost {
  return {
    id,
    content: { text: `post ${id}` },
    attachments: {
      media: [{ id: `media-${id}`, type: 'image' }],
    },
    linkPreviews: [],
    user: {
      id: `user-${id}`,
      username: `user-${id}`,
      name: { displayName: `User ${id}` },
      avatar: `avatar-${id}`,
      verified: true,
    },
    authors: [{
      id: `user-${id}`,
      username: `user-${id}`,
      name: { displayName: `User ${id}` },
      role: 'owner',
      status: 'accepted',
    }],
    engagement: {
      likes: 3,
      downvotes: 1,
      boosts: 2,
      replies: 4,
      saves: 5,
      views: 6,
      impressions: 7,
    },
    viewerState: {
      isOwner: false,
      isCollaborator: false,
      isLiked: false,
      isDownvoted: false,
      isBoosted: false,
      isSaved: false,
    },
    permissions: {
      canReply: true,
      canDelete: false,
      canPin: false,
      canViewSources: false,
    },
    metadata: {
      visibility: PostVisibility.PUBLIC,
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:00.000Z',
    },
    ...overrides,
  };
}

describe('canonical post cache contract', () => {
  // `PostItem` reads `storePost ?? post`, so the cached copy WINS over the one
  // the API just returned. Anything this converter drops is therefore invisible
  // on every feed surface while the raw API response still has it — and both of
  // these are optional on `HydratedPost`, so omitting them type-checks cleanly.
  //
  it('carries the lane, which decides which profile tab a post is on', () => {
    const post = makePost('signed', {
      lane: { id: 'lane-1', name: 'Opinion', displayMode: 'mixed' },
    });

    const item = toFeedItem(post);

    expect(item.lane).toEqual(post.lane);

    // And it must survive the SQLite round trip, which is what a warm start reads.
    const restored = rowToFeedItem(postToRow(item));
    expect(restored?.lane).toEqual(post.lane);
  });

  it('adds only local rendering fields without synthesizing identity or viewer aliases', () => {
    const post = makePost('feed');
    const item = toFeedItem(post);

    expect(item.user).toBe(post.user);
    expect(item.authors).toBe(post.authors);
    expect(item.viewerState).toBe(post.viewerState);
    expect(item.mediaIds).toEqual(['media-feed']);
    expect(item.date).toBe(post.metadata.createdAt);
    expect(item).not.toHaveProperty('original');
    expect(item).not.toHaveProperty('quoted');
    expect(item).not.toHaveProperty('isLiked');
    expect(item).not.toHaveProperty('isDownvoted');
    expect(item).not.toHaveProperty('isBoosted');
    expect(item).not.toHaveProperty('isSaved');
    expect(item.user).not.toHaveProperty('handle');
    expect(item.user).not.toHaveProperty('avatarUrl');
    expect(item.user).not.toHaveProperty('isVerified');
  });

  it('keeps a boost and its original on the same canonical contract', () => {
    const original: HydratedPostSummary = makePost('original');
    const boost = makePost('boost', {
      content: { text: '' },
      boost: {
        actor: makePost('actor').user,
        originalPost: original,
      },
    });

    const item = toFeedItem(boost);
    const embedded = item.boost?.originalPost;

    expect(embedded?.id).toBe('original');
    expect(embedded?.viewerState).toEqual(original.viewerState);
    expect(embedded).not.toHaveProperty('isLiked');
    expect(embedded?.user).not.toHaveProperty('handle');
    expect(item).not.toHaveProperty('original');
  });

  it('keeps quote relations canonical without local aliases', () => {
    const quoted: HydratedPostSummary = makePost('quoted');
    const quote = makePost('quote', {
      originalPost: quoted,
      quotedPost: quoted,
    });

    const item = toFeedItem(quote);

    expect(item.originalPost?.id).toBe('quoted');
    expect(item.quotedPost?.id).toBe('quoted');
    expect(item).not.toHaveProperty('original');
    expect(item).not.toHaveProperty('quoted');
  });

  /**
   * `PostItem` reads `storePost ?? post`, so this converter decides what a post
   * looks like on every feed surface — the cached copy WINS over the API
   * response. A CHANNEL post is the case that proves it: its author IS the
   * channel account, so its whole signature travels in `user`, and a converter
   * that dropped or reshaped that field would render the post under nobody.
   *
   * `FeedItem` extends `HydratedPost`, so a field this function forgets is a
   * runtime-only loss — nothing about it is visible to the type-check.
   */
  it('carries a channel account author verbatim, through SQLite too', () => {
    const post = makePost('channel-post', {
      user: {
        id: 'channel-account-1',
        username: 'news',
        name: { displayName: 'News' },
        avatar: 'avatar-news',
      },
      metadata: {
        visibility: PostVisibility.PUBLIC,
        createdAt: '2026-07-26T00:00:00.000Z',
        updatedAt: '2026-07-26T00:00:00.000Z',
        replyPermission: ['nobody'],
      },
    });

    const item = toFeedItem(post);
    expect(item.user).toEqual(post.user);

    const restored = rowToFeedItem(postToRow(item));
    expect(restored?.user).toEqual(post.user);
  });

  it('rehydrates mutable state from columns but rejects legacy raw rows', () => {
    const row = postToRow(toFeedItem(makePost('stored')));
    row.is_liked = 1;
    row.is_saved = 1;
    row.likes_count = 9;

    const restored = rowToFeedItem(row);
    expect(restored?.viewerState.isLiked).toBe(true);
    expect(restored?.viewerState.isSaved).toBe(true);
    expect(restored?.engagement.likes).toBe(9);
    expect(restored).not.toHaveProperty('isLiked');
    expect(restored?.user).not.toHaveProperty('handle');

    row.raw_json = JSON.stringify({
      ...restored,
      isLiked: true,
    });
    expect(rowToFeedItem(row)).toBeNull();

    row.raw_json = JSON.stringify({
      ...toFeedItem(makePost('legacy-relation')),
      original: toFeedItem(makePost('old-original')),
    });
    expect(rowToFeedItem(row)).toBeNull();
  });
});
