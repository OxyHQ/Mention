import {
  buildAuthorship,
  buildOwnerEntry,
  getAcceptedCollaborators,
  getHeaderAuthorshipEntries,
  getNotificationRecipients,
  getOwner,
  getOwnerId,
  getPendingCollaborators,
  getViewerEntry,
  hasCollaborators,
  isProfileVisible,
  normalizeAuthorship,
  validateCollaboratorIds,
} from '../../utils/postAuthorship';

describe('postAuthorship', () => {
  const ownerId = 'owner-1';
  const collabA = 'collab-a';
  const collabB = 'collab-b';

  it('buildAuthorship creates owner + pending collaborators', () => {
    const authorship = buildAuthorship(ownerId, [collabA, collabB]);
    expect(authorship).toHaveLength(3);
    expect(getOwner(authorship)).toEqual(expect.objectContaining({ oxyUserId: ownerId, role: 'owner', status: 'accepted' }));
    expect(getPendingCollaborators(authorship)).toHaveLength(2);
  });

  it('normalizeAuthorship falls back to owner entry', () => {
    expect(normalizeAuthorship(undefined, ownerId)).toEqual([buildOwnerEntry(ownerId)]);
  });

  it('getOwnerId returns owner oxyUserId', () => {
    const authorship = buildAuthorship(ownerId, [collabA]);
    expect(getOwnerId(authorship)).toBe(ownerId);
  });

  it('isProfileVisible is true for owner and accepted collaborator only', () => {
    const authorship = buildAuthorship(ownerId, [collabA]);
    expect(isProfileVisible(authorship, ownerId)).toBe(true);
    expect(isProfileVisible(authorship, collabA)).toBe(false);

    authorship[1].status = 'accepted';
    expect(isProfileVisible(authorship, collabA)).toBe(true);
  });

  it('getNotificationRecipients includes owner and accepted collaborators', () => {
    const authorship = buildAuthorship(ownerId, [collabA, collabB]);
    authorship[1].status = 'accepted';
    expect(getNotificationRecipients(authorship).sort()).toEqual([ownerId, collabA].sort());
  });

  it('getViewerEntry finds viewer role', () => {
    const authorship = buildAuthorship(ownerId, [collabA]);
    expect(getViewerEntry(authorship, collabA)?.role).toBe('collaborator');
    expect(getViewerEntry(authorship, ownerId)?.role).toBe('owner');
  });

  it('hasCollaborators detects collaborator entries', () => {
    expect(hasCollaborators([buildOwnerEntry(ownerId)])).toBe(false);
    expect(hasCollaborators(buildAuthorship(ownerId, [collabA]))).toBe(true);
  });

  it('getHeaderAuthorshipEntries returns owner + accepted only', () => {
    const authorship = buildAuthorship(ownerId, [collabA, collabB]);
    authorship[1].status = 'accepted';
    expect(getHeaderAuthorshipEntries(authorship)).toHaveLength(2);
    expect(getAcceptedCollaborators(authorship)).toHaveLength(1);
  });

  it('validateCollaboratorIds rejects self and enforces cap', () => {
    expect(() => validateCollaboratorIds(ownerId, [ownerId])).toThrow(/yourself/);
    expect(() => validateCollaboratorIds(ownerId, Array.from({ length: 6 }, (_, i) => `u-${i}`))).toThrow(/At most/);
    expect(validateCollaboratorIds(ownerId, [collabA, collabA, collabB])).toEqual([collabA, collabB]);
  });
});
