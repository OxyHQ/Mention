import { describe, it, expect, vi } from 'vitest';
import { postCollaborationService, CollabValidationError, CollabStateError } from '../../services/PostCollaborationService';
import { buildAuthorship } from '../../utils/postAuthorship';
import { Post } from '../../models/Post';

const { federateNewPost } = vi.hoisted(() => ({ federateNewPost: vi.fn(async () => undefined) }));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: vi.fn(() => ({
    getUsersByIds: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, type: 'local', username: id, name: { displayName: id } })),
    ),
    getUserById: vi.fn(async (id: string) => ({ id, type: 'local', username: id, name: { displayName: id } })),
  })),
}));

vi.mock('../../utils/notificationUtils', () => ({
  createNotification: vi.fn(async () => undefined),
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: {
    hydratePosts: vi.fn(async () => [{}]),
  },
}));

vi.mock('../../models/Post', () => ({
  Post: { findById: vi.fn() },
}));

vi.mock('../../services/serviceRegistry', () => ({
  getPostFederator: () => ({ federateNewPost }),
}));

function fakePost(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'post-1',
    oxyUserId: 'owner-1',
    status: 'published',
    federation: undefined,
    save: vi.fn(async function (this: unknown) {
      return this;
    }),
    toObject: vi.fn(() => ({})),
    ...overrides,
  };
}

describe('PostCollaborationService', () => {
  describe('validateInvites', () => {
    it('returns validated unique collaborator ids', async () => {
      const ids = await postCollaborationService.validateInvites('owner-1', ['c-1', 'c-2']);
      expect(ids).toEqual(['c-1', 'c-2']);
    });

    it('rejects self-invite', async () => {
      await expect(postCollaborationService.validateInvites('owner-1', ['owner-1'])).rejects.toBeInstanceOf(CollabValidationError);
    });
  });

  describe('buildAuthorship', () => {
    it('creates owner + pending collaborators', () => {
      const authorship = postCollaborationService.buildAuthorship('owner-1', ['c-1']);
      expect(authorship[0]).toMatchObject({ oxyUserId: 'owner-1', role: 'owner', status: 'accepted' });
      expect(authorship[1]).toMatchObject({ oxyUserId: 'c-1', role: 'collaborator', status: 'pending' });
    });
  });

  describe('accept — deferred federation gate', () => {
    beforeEach(() => {
      federateNewPost.mockClear();
    });

    it('federates once the LAST pending invite is accepted', async () => {
      const post = fakePost({ authorship: buildAuthorship('owner-1', ['c-1']) });
      (Post.findById as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(post);

      await postCollaborationService.accept('post-1', 'c-1');

      expect(federateNewPost).toHaveBeenCalledTimes(1);
      expect(federateNewPost).toHaveBeenCalledWith(post, 'owner-1', 'owner-1');
    });

    it('does NOT federate while another invite is still pending', async () => {
      const post = fakePost({ authorship: buildAuthorship('owner-1', ['c-1', 'c-2']) });
      (Post.findById as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(post);

      await postCollaborationService.accept('post-1', 'c-1');

      expect(federateNewPost).not.toHaveBeenCalled();
    });

    it('does NOT federate a scheduled post on accept (defers to publish)', async () => {
      const post = fakePost({ status: 'scheduled', authorship: buildAuthorship('owner-1', ['c-1']) });
      (Post.findById as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(post);

      await postCollaborationService.accept('post-1', 'c-1');

      expect(federateNewPost).not.toHaveBeenCalled();
    });

    it('throws when the viewer has no pending invite', async () => {
      const post = fakePost({ authorship: buildAuthorship('owner-1', ['c-1']) });
      (Post.findById as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(post);

      await expect(postCollaborationService.accept('post-1', 'stranger')).rejects.toBeInstanceOf(CollabStateError);
      expect(federateNewPost).not.toHaveBeenCalled();
    });
  });

  describe('decline — deferred federation gate', () => {
    beforeEach(() => {
      federateNewPost.mockClear();
    });

    it('federates the owner post when the last invite is declined', async () => {
      const post = fakePost({ authorship: buildAuthorship('owner-1', ['c-1']) });
      (Post.findById as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(post);

      await postCollaborationService.decline('post-1', 'c-1');

      expect(federateNewPost).toHaveBeenCalledTimes(1);
    });
  });
});

describe('buildAuthorship helper', () => {
  it('always includes owner first', () => {
    const authorship = buildAuthorship('o1', []);
    expect(authorship).toHaveLength(1);
    expect(authorship[0].role).toBe('owner');
  });
});

describe('CollabStateError', () => {
  it('is named correctly', () => {
    expect(new CollabStateError('x').name).toBe('CollabStateError');
  });
});
