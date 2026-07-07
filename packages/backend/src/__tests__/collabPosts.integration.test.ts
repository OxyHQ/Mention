import { buildAuthorship, buildAuthorFeedMatch, isProfileVisible } from '../utils/postAuthorship';
import { postCollaborationService } from '../services/PostCollaborationService';

jest.mock('../utils/oxyHelpers', () => ({
  getServiceOxyClient: jest.fn(() => ({
    getUsersByIds: jest.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, type: 'local', username: id, name: { displayName: id } })),
    ),
  })),
}));

describe('collaborative posts integration', () => {
  it('builds authorship with owner always accepted', () => {
    const authorship = buildAuthorship('owner-1', ['c-1', 'c-2']);
    expect(authorship[0]).toMatchObject({ role: 'owner', status: 'accepted' });
    expect(authorship[1]).toMatchObject({ role: 'collaborator', status: 'pending' });
  });

  it('profile visibility requires accepted collaborator', () => {
    const authorship = buildAuthorship('owner-1', ['collab-1']);
    expect(isProfileVisible(authorship, 'owner-1')).toBe(true);
    expect(isProfileVisible(authorship, 'collab-1')).toBe(false);
    authorship[1].status = 'accepted';
    expect(isProfileVisible(authorship, 'collab-1')).toBe(true);
  });

  it('author feed match uses authorship elemMatch', () => {
    expect(buildAuthorFeedMatch('user-x')).toEqual({
      authorship: { $elemMatch: { oxyUserId: 'user-x', status: 'accepted' } },
    });
  });

  it('skips federation when collaborators present', async () => {
    const authorship = buildAuthorship('owner', ['c1']);
    expect(authorship.some((e) => e.role === 'collaborator')).toBe(true);
    const validated = await postCollaborationService.validateInvites('owner', ['c1']);
    expect(validated).toEqual(['c1']);
  });
});
