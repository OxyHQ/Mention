import type { HydratedPost } from '@mention/shared-types';
import { PostVisibility } from '@mention/shared-types/post';
import { toFeedItem } from '@/db/feedItem';
import { Post, POST_SHAPE_VERSION } from '../posts';

// Posts refer to the Oxy SDK's `User`; the real one, without the SDK's UI barrel.
jest.mock('@oxy.so/services/ui/client', () => jest.requireActual('@/test-support/oxyUsers'));

/**
 * A stored post is the JSON of a `FeedItem` (`data/posts`), and it spreads back
 * as it was written. So the shape drifts independently of the store: changing
 * what `toFeedItem` carries changes what NEW records hold while every record
 * already on disk keeps answering with the old shape, until something evicts it.
 *
 * That is not theoretical. `lane` and `channel` were added to the converter
 * without a version bump, and channel posts rendered as "Unknown user" from
 * cache while the same post fetched fresh rendered correctly. Removing a field
 * is the same hazard from the other side.
 *
 * `POST_SHAPE_VERSION` is the only thing that evicts a stale record, so the two
 * are pinned together here: change what the converter persists and this fails
 * until the version moves with it.
 */
const PERSISTED_POST_KEYS = [
  'allMediaIds',
  'attachments',
  'authors',
  'authorship',
  'boost',
  'community',
  'communityNote',
  'content',
  'context',
  'crosspost',
  'date',
  'documents',
  'documentsPending',
  'engagement',
  'id',
  'importedFrom',
  'lane',
  'mediaIds',
  'metadata',
  'originalPost',
  'parentPostId',
  'permissions',
  'quotedPost',
  'quotedPostUnavailable',
  'replyContext',
  'user',
  'viewerState',
] as const;

/**
 * The fields whose embedded record a stored post keeps only the id of, and
 * where it lives instead: a related post in `post`, a person in the Oxy SDK's
 * `user`. Moving a field in or out of this set changes what is on disk exactly
 * as a key does.
 */
const STORED_REFS = [
  'boost.actor:user',
  'boost.originalPost:post',
  'community:user',
  'originalPost:post',
  'quotedPost:post',
  'replyContext.parentAuthor:user',
  'user:user',
] as const;

/** The version that must ship with the key set and the refs above. */
const VERSION_FOR_THESE_KEYS = 17;

function makeFullyPopulatedPost(): HydratedPost {
  return {
    id: 'post-1',
    content: { text: 'body' },
    attachments: { media: [{ id: 'media-1', type: 'image' }] },
    documents: [],
    user: {
      id: 'user-1',
      username: 'user1',
      name: { displayName: 'User One' },
      avatar: 'avatar-1',
    },
    authors: [
      {
        id: 'user-1',
        username: 'user1',
        name: { displayName: 'User One' },
        role: 'owner',
        status: 'accepted',
      },
    ],
    authorship: [{ oxyUserId: 'user-1', role: 'owner', status: 'accepted' }],
    engagement: {
      likes: 0,
      downvotes: 0,
      boosts: 0,
      replies: 0,
      saves: 0,
      views: 0,
      impressions: 0,
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
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
    },
    lane: { id: 'lane-1', name: 'Opinion', displayMode: 'mixed' },
    community: {
      id: 'community-1',
      username: 'technology@lemmy.example',
      name: { displayName: 'Technology' },
    },
    crosspost: {
      variants: [
        { network: 'instagram.com', label: 'Instagram', postId: 'post-1', rendered: true },
        { network: 'threads.net', label: 'Threads', postId: 'post-2', rendered: false },
      ],
    },
    importedFrom: { platform: 'mastodon', sourceUrl: 'https://mastodon.example/@user1/1' },
    communityNote: {
      id: 'note-1',
      text: 'Context',
      sourceUrls: ['https://example.com/source'],
      status: 'shown',
      createdAt: '2026-08-02T00:00:00.000Z',
    },
    originalPost: null,
    quotedPost: null,
    quotedPostUnavailable: true,
    boost: null,
  };
}

describe('the stored post shape is pinned to its version', () => {
  it('carries exactly the keys the pinned version was cut for', () => {
    const keys = Object.keys(toFeedItem(makeFullyPopulatedPost())).sort();

    // A diff here means the persisted payload changed. Update BOTH this list and
    // `POST_SHAPE_VERSION`, or every existing client keeps serving the old shape from
    // disk with no error anywhere.
    expect(keys).toEqual([...PERSISTED_POST_KEYS]);
  });

  it('stores exactly the refs the pinned version was cut for', () => {
    const refs = Post.definition
      .refs()
      .map((ref) => `${ref.path.join('.')}:${ref.target.type}`)
      .sort();

    // A diff here means a stored post now keeps (or stops keeping) an embedded
    // record by id. Update BOTH this list and `POST_SHAPE_VERSION`.
    expect(refs).toEqual([...STORED_REFS]);
  });

  it('ships the shape version that matches that key set', () => {
    expect(POST_SHAPE_VERSION).toBe(VERSION_FOR_THESE_KEYS);
  });
});
