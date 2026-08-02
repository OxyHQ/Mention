import type { HydratedPost } from '@mention/shared-types';
import { PostVisibility } from '@mention/shared-types/post';
import { toFeedItem } from '../feedItem';
import { SCHEMA_VERSION } from '../migrations';

/**
 * The local cache keeps most of a post as a serialized `FeedItem` in `raw_json`,
 * and `rowToFeedItem` spreads whatever it finds there. So the payload's shape
 * drifts independently of every column: changing what `toFeedItem` carries
 * changes what NEW rows hold while every row already on disk keeps answering
 * with the old shape — forever, since nothing evicts it.
 *
 * That is not theoretical. `lane` and `channel` were added to the converter
 * without a schema bump, and channel posts rendered as "Unknown user" from cache
 * while the same post fetched fresh rendered correctly. It looks like a render
 * bug and is not one, which is what made it expensive to find.
 *
 * REMOVING a field is the same hazard from the other side, which is why v8 exists:
 * `channel` is gone from the converter, but a v7 row on disk still carries one
 * beside the degraded `user` the old backend paired it with.
 *
 * `SCHEMA_VERSION` is the only thing that evicts a stale row, and its own
 * docstring used to say "bump when the table definitions change" — which this
 * class of change does not do. So the two are pinned together here: change what
 * the converter persists and this fails until the version moves with it.
 */
const PERSISTED_POST_KEYS = [
  'allMediaIds',
  'attachments',
  'authors',
  'authorship',
  'boost',
  'content',
  'context',
  'date',
  'engagement',
  'id',
  'lane',
  'linkPreviews',
  'mediaIds',
  'metadata',
  'originalPost',
  'parentPostId',
  'permissions',
  'quotedPost',
  'replyContext',
  'user',
  'viewerState',
] as const;

/** The version that must ship with the key set above. */
const VERSION_FOR_THESE_KEYS = 8;

function makeFullyPopulatedPost(): HydratedPost {
  return {
    id: 'post-1',
    content: { text: 'body' },
    attachments: { media: [{ id: 'media-1', type: 'image' }] },
    linkPreviews: [],
    user: {
      id: 'user-1',
      username: 'user1',
      name: { displayName: 'User One' },
      avatar: 'avatar-1',
    },
    authors: [{
      id: 'user-1',
      username: 'user1',
      name: { displayName: 'User One' },
      role: 'owner',
      status: 'accepted',
    }],
    authorship: [{ oxyUserId: 'user-1', role: 'owner', status: 'accepted' }],
    engagement: {
      likes: 0, downvotes: 0, boosts: 0, replies: 0, saves: 0, views: 0, impressions: 0,
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
    originalPost: null,
    quotedPost: null,
    boost: null,
  };
}

describe('persisted post shape is pinned to the cache schema version', () => {
  it('carries exactly the keys the pinned version was cut for', () => {
    const keys = Object.keys(toFeedItem(makeFullyPopulatedPost())).sort();

    // A diff here means the persisted payload changed. Update BOTH this list and
    // `SCHEMA_VERSION`, or every existing client keeps serving the old shape from
    // disk with no error anywhere.
    expect(keys).toEqual([...PERSISTED_POST_KEYS]);
  });

  it('ships the schema version that matches that key set', () => {
    expect(SCHEMA_VERSION).toBe(VERSION_FOR_THESE_KEYS);
  });
});
