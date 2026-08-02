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
  // Dropping `channel` was not cosmetic: the backend deliberately degrades
  // `post.user` to "Unknown user" on a channel post and expects the channel to
  // supply the identity, so a lost `channel` renders the post as an unknown
  // author rather than as the channel that published it.
  it('carries the lane and the channel, which decide how a post is signed', () => {
    const post = makePost('signed', {
      lane: { id: 'lane-1', name: 'Opinion', displayMode: 'mixed' },
      channel: { id: 'ch-1', handle: 'nateonoxy', title: 'Nate on Oxy', signPosts: false },
    });

    const item = toFeedItem(post);

    expect(item.lane).toEqual(post.lane);
    expect(item.channel).toEqual(post.channel);

    // And it must survive the SQLite round trip, which is what a warm start reads.
    const restored = rowToFeedItem(postToRow(item));
    expect(restored?.lane).toEqual(post.lane);
    expect(restored?.channel).toEqual(post.channel);
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
   * response. A channel is the signature of the row (its avatar, its name) and
   * the reason a channel post says nothing about replies; drop it here and a
   * channel post renders under its author's face and reports "Replies are off",
   * because the `['nobody']` the server persists as defence in depth survives in
   * `metadata` while the channel that explains it does not.
   *
   * `FeedItem` extends `HydratedPost`, so a field this function forgets is a
   * runtime-only loss — nothing about it is visible to the type-check.
   */
  it('carries the channel that signs a post, through SQLite too', () => {
    const channel = { id: 'channel-1', handle: 'news', title: 'News', signPosts: true };
    const post = makePost('channel-post', {
      channel,
      metadata: {
        visibility: PostVisibility.PUBLIC,
        createdAt: '2026-07-26T00:00:00.000Z',
        updatedAt: '2026-07-26T00:00:00.000Z',
        replyPermission: ['nobody'],
      },
    });

    const item = toFeedItem(post);
    expect(item.channel).toEqual(channel);

    const restored = rowToFeedItem(postToRow(item));
    expect(restored?.channel).toEqual(channel);
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
