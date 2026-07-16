import { describe, it, expect, vi } from 'vitest';
import { postCollaborationService, CollabValidationError, CollabStateError } from '../../services/PostCollaborationService';
import { buildAuthorship } from '../../utils/postAuthorship';
import { Post, IPost } from '../../models/Post';

const { federateNewPost } = vi.hoisted(() => ({ federateNewPost: vi.fn(async () => undefined) }));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: vi.fn(() => ({
    getUsersByIds: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, type: 'local', username: id, name: { displayName: id } })),
    ),
    getUserById: vi.fn(async (id: string) => ({ id, type: 'local', username: id, name: { displayName: id } })),
    getProfileByUsername: vi.fn(async (username: string) => {
      if (username === 'ghost') {
        throw new Error('not found');
      }
      if (username === 'remote') {
        return { id: 'fed-1', type: 'federated', username: 'remote' };
      }
      return { id: `user-${username}`, type: 'local', username };
    }),
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

function fakePost(overrides: Record<string, unknown> = {}): IPost {
  return {
    _id: 'post-1',
    oxyUserId: 'owner-1',
    status: 'published',
    federation: undefined,
    metadata: { collabFederationDeferred: true },
    markModified: vi.fn(),
    save: vi.fn(async function (this: unknown) {
      return this;
    }),
    toObject: vi.fn(() => ({})),
    ...overrides,
  } as unknown as IPost;
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

  describe('resolveCollaboratorRefs', () => {
    it('returns undefined when no collaborators provided', async () => {
      await expect(postCollaborationService.resolveCollaboratorRefs('owner-1')).resolves.toBeUndefined();
    });

    it('passes through collaborator IDs', async () => {
      await expect(
        postCollaborationService.resolveCollaboratorRefs('owner-1', ['c-1', 'c-2']),
      ).resolves.toEqual(['c-1', 'c-2']);
    });

    it('resolves local handles to IDs', async () => {
      await expect(
        postCollaborationService.resolveCollaboratorRefs('owner-1', undefined, ['@alice', 'bob']),
      ).resolves.toEqual(['user-alice', 'user-bob']);
    });

    it('rejects unknown handles', async () => {
      await expect(
        postCollaborationService.resolveCollaboratorRefs('owner-1', undefined, ['ghost']),
      ).rejects.toThrow('Unknown user: @ghost');
    });

    it('rejects federated users from handle lookup', async () => {
      await expect(
        postCollaborationService.resolveCollaboratorRefs('owner-1', undefined, ['remote']),
      ).rejects.toThrow('Federated users cannot be collaborators');
    });
  });

  describe('buildAuthorship', () => {
    it('creates owner + pending collaborators', () => {
      const authorship = postCollaborationService.buildAuthorship('owner-1', ['c-1']);
      expect(authorship[0]).toMatchObject({ oxyUserId: 'owner-1', role: 'owner', status: 'accepted' });
      expect(authorship[1]).toMatchObject({ oxyUserId: 'c-1', role: 'collaborator', status: 'pending' });
    });
  });

  describe('attachCollaborators', () => {
    it('appends pending collaborators to a solo post', async () => {
      const post = fakePost({ authorship: buildAuthorship('owner-1', []) });
      await postCollaborationService.attachCollaborators(post, 'owner-1', ['c-1']);
      expect(post.authorship).toHaveLength(2);
      expect(post.authorship?.[1]).toMatchObject({ oxyUserId: 'c-1', role: 'collaborator', status: 'pending' });
      expect((post.metadata as { collabFederationDeferred?: boolean }).collabFederationDeferred).toBe(true);
    });

    it('does not set collabFederationDeferred when post already federated', async () => {
      const post = fakePost({
        authorship: buildAuthorship('owner-1', []),
        metadata: { federationDelivered: true },
      });
      await postCollaborationService.attachCollaborators(post, 'owner-1', ['c-1']);
      expect((post.metadata as { collabFederationDeferred?: boolean }).collabFederationDeferred).toBeUndefined();
    });

    it('rejects posts that already have collaborators', async () => {
      const post = fakePost({ authorship: buildAuthorship('owner-1', ['c-1']) });
      await expect(
        postCollaborationService.attachCollaborators(post, 'owner-1', ['c-2']),
      ).rejects.toBeInstanceOf(CollabStateError);
    });

    it('rejects replies', async () => {
      const post = fakePost({ authorship: buildAuthorship('owner-1', []), parentPostId: 'parent-1' });
      await expect(
        postCollaborationService.attachCollaborators(post, 'owner-1', ['c-1']),
      ).rejects.toBeInstanceOf(CollabValidationError);
    });
  });

  describe('autoAcceptInvites', () => {
    beforeEach(() => {
      federateNewPost.mockClear();
    });

    it('accepts pending invites for users in the set', async () => {
      const post = fakePost({ authorship: buildAuthorship('owner-1', ['c-1', 'c-2']) });
      const result = await postCollaborationService.autoAcceptInvites(post, new Set(['c-1']));

      expect(result.authorship?.find((e) => e.oxyUserId === 'c-1')?.status).toBe('accepted');
      expect(result.authorship?.find((e) => e.oxyUserId === 'c-2')?.status).toBe('pending');
      expect(post.save).toHaveBeenCalledTimes(1);
      expect(federateNewPost).not.toHaveBeenCalled();
    });

    it('federates when auto-accept resolves the last pending invite', async () => {
      const post = fakePost({ authorship: buildAuthorship('owner-1', ['c-1']) });
      await postCollaborationService.autoAcceptInvites(post, new Set(['c-1']));
      expect(federateNewPost).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when no pending invite matches', async () => {
      const post = fakePost({ authorship: buildAuthorship('owner-1', ['c-1']) });
      const result = await postCollaborationService.autoAcceptInvites(post, new Set(['stranger']));
      expect(result).toBe(post);
      expect(post.save).not.toHaveBeenCalled();
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

    it('does NOT federate when collabFederationDeferred is unset (solo post converted via edit)', async () => {
      const post = fakePost({
        authorship: buildAuthorship('owner-1', ['c-1']),
        metadata: { federationDelivered: true },
      });
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

    it('marks the accepting user accepted on the returned post (co-authorship contract)', async () => {
      // The controller hydrates and returns THIS post; the client reads the
      // resulting `authors[]`/`viewerState.isCollaborator` to show the new
      // collaboration everywhere. Guard that accept actually flips the entry.
      const post = fakePost({ authorship: buildAuthorship('owner-1', ['c-1']) });
      (Post.findById as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(post);

      const result = await postCollaborationService.accept('post-1', 'c-1');

      expect(result.authorship?.find((e) => e.oxyUserId === 'c-1')).toMatchObject({
        role: 'collaborator',
        status: 'accepted',
      });
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

    it('marks the declining user declined on the returned post, leaving others pending', async () => {
      // The controller hydrates and returns THIS post so the client can flip the
      // invite row from actionable buttons to a resolved "You declined" state.
      const post = fakePost({ authorship: buildAuthorship('owner-1', ['c-1', 'c-2']) });
      (Post.findById as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(post);

      const result = await postCollaborationService.decline('post-1', 'c-1');

      expect(result.authorship?.find((e) => e.oxyUserId === 'c-1')?.status).toBe('declined');
      expect(result.authorship?.find((e) => e.oxyUserId === 'c-2')?.status).toBe('pending');
      // Another invite is still pending, so the deferred federation must NOT fire.
      expect(federateNewPost).not.toHaveBeenCalled();
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
