import { PostVisibility, type HydratedPost, type PostContent } from '@mention/shared-types';

/**
 * A scheduled post exactly as `GET /posts/scheduled` now serves it: the hydrated
 * DTO, with the body already RESOLVED into `content.text`, media carrying
 * display URLs, an author — and `metadata.scheduledFor`, the field hydration
 * emits so the composer can show the publish time.
 *
 * Built as a real `HydratedPost` rather than cast into one on purpose: this is
 * the contract the preview depends on, so a rename in the DTO should break these
 * tests rather than slip past a cast.
 */
export function scheduledPostFixture(overrides: {
  id?: string;
  content?: PostContent;
  scheduledFor?: Date | null;
} = {}): HydratedPost {
  const { id = 'post-soon', scheduledFor = null } = overrides;

  return {
    id,
    content: overrides.content ?? {
      text: 'Ship the scheduled queue',
      media: [
        { id: 'media-1', type: 'image', url: 'https://cdn.test/1' },
        { id: 'media-2', type: 'image', url: 'https://cdn.test/2' },
      ],
    },
    attachments: {},
    user: { id: 'viewer-1', username: 'author', name: { displayName: 'Author' } },
    authors: [],
    engagement: {
      likes: 0,
      downvotes: 0,
      boosts: 0,
      replies: 0,
    },
    viewerState: {
      isOwner: true,
      isCollaborator: false,
      isLiked: false,
      isDownvoted: false,
      isBoosted: false,
      isSaved: false,
    },
    permissions: {
      canReply: true,
      canDelete: true,
      canPin: true,
      canViewSources: true,
    },
    metadata: {
      visibility: PostVisibility.PUBLIC,
      createdAt: '2026-08-01T09:00:00.000Z',
      updatedAt: '2026-08-01T09:00:00.000Z',
      status: 'scheduled',
      scheduledFor: scheduledFor === null ? undefined : scheduledFor.toISOString(),
    },
  };
}
