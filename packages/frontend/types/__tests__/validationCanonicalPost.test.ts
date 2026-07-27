import type { HydratedPost } from '@mention/shared-types';
import { PostVisibility } from '@mention/shared-types/post';
import { validateNotifications } from '../validation';

jest.mock('@/lib/logger', () => ({
  logger: {
    warn: jest.fn(),
  },
}));

function canonicalPost(): HydratedPost {
  return {
    id: 'post-1',
    content: { text: 'Canonical notification post' },
    attachments: {},
    user: {
      id: 'user-1',
      username: 'alice',
      name: { displayName: 'Alice' },
      avatar: 'avatar-1',
      verified: true,
    },
    authors: [{
      id: 'user-1',
      username: 'alice',
      name: { displayName: 'Alice' },
      role: 'owner',
      status: 'accepted',
    }],
    engagement: {
      likes: 1,
      downvotes: 0,
      boosts: 0,
      replies: 0,
    },
    viewerState: {
      isOwner: false,
      isCollaborator: false,
      isLiked: true,
      isDownvoted: false,
      isBoosted: false,
      isSaved: true,
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
  };
}

function notification(post: unknown) {
  return {
    _id: 'notification-1',
    recipientId: 'viewer-1',
    actorId: 'user-1',
    type: 'like',
    entityId: 'post-1',
    entityType: 'post',
    read: false,
    createdAt: '2026-07-26T00:00:00.000Z',
    post,
  };
}

describe('notification embedded post contract', () => {
  it('accepts the canonical hydrated identity and viewerState shape', () => {
    const [result] = validateNotifications([notification(canonicalPost())]);

    expect(result?.post?.user.name.displayName).toBe('Alice');
    expect(result?.post?.viewerState.isLiked).toBe(true);
    expect(result?.post).not.toHaveProperty('isLiked');
  });

  it.each([
    ['top-level viewer flag', { isLiked: true }],
    ['flat handle', { user: { handle: '@legacy' } }],
    ['flat avatar URL', { user: { avatarUrl: 'https://legacy.invalid/a.png' } }],
    ['flat verification flag', { user: { isVerified: true } }],
  ])('drops a notification containing a legacy %s', (_label, mutation) => {
    const post = canonicalPost();
    const legacyPost = {
      ...post,
      ...mutation,
      user: {
        ...post.user,
        ...('user' in mutation ? mutation.user : {}),
      },
    };

    expect(validateNotifications([notification(legacyPost)])).toEqual([]);
  });
});
