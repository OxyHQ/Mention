import { postCollaborationService, CollabValidationError, CollabStateError } from '../../services/PostCollaborationService';
import { buildAuthorship } from '../../utils/postAuthorship';

jest.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: jest.fn(() => ({
    getUsersByIds: jest.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, type: 'local', username: id, name: { displayName: id } })),
    ),
  })),
}));

jest.mock('../../utils/notificationUtils', () => ({
  createNotification: jest.fn(async () => undefined),
}));

jest.mock('../../services/PostHydrationService', () => ({
  postHydrationService: {
    hydratePosts: jest.fn(async () => [{}]),
  },
}));

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
