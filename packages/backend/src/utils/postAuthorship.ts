import type { PostAuthorshipEntry, PostAuthorRole, PostAuthorStatus } from '@mention/shared-types';
import { MAX_POST_COLLABORATORS } from '@mention/shared-types';

export type { PostAuthorshipEntry, PostAuthorRole, PostAuthorStatus };

export function buildOwnerEntry(oxyUserId: string): PostAuthorshipEntry {
  return { oxyUserId, role: 'owner', status: 'accepted' };
}

export function buildCollaboratorEntry(oxyUserId: string, invitedAt: Date = new Date()): PostAuthorshipEntry {
  return { oxyUserId, role: 'collaborator', status: 'pending', invitedAt: invitedAt.toISOString() };
}

export function buildAuthorship(ownerId: string, collaboratorIds: string[] = []): PostAuthorshipEntry[] {
  const owner = buildOwnerEntry(ownerId);
  const collaborators = collaboratorIds.map((id) => buildCollaboratorEntry(id));
  return [owner, ...collaborators];
}

export function normalizeAuthorship(
  authorship: PostAuthorshipEntry[] | undefined,
  fallbackOwnerId?: string,
): PostAuthorshipEntry[] {
  if (authorship && authorship.length > 0) {
    return authorship;
  }
  if (fallbackOwnerId) {
    return [buildOwnerEntry(fallbackOwnerId)];
  }
  return [];
}

export function getOwner(authorship: PostAuthorshipEntry[]): PostAuthorshipEntry | undefined {
  return authorship.find((entry) => entry.role === 'owner');
}

export function getOwnerId(authorship: PostAuthorshipEntry[], fallbackOwnerId?: string): string | undefined {
  return getOwner(authorship)?.oxyUserId ?? fallbackOwnerId;
}

export function getAcceptedCollaborators(authorship: PostAuthorshipEntry[]): PostAuthorshipEntry[] {
  return authorship.filter((entry) => entry.role === 'collaborator' && entry.status === 'accepted');
}

export function getPendingCollaborators(authorship: PostAuthorshipEntry[]): PostAuthorshipEntry[] {
  return authorship.filter((entry) => entry.role === 'collaborator' && entry.status === 'pending');
}

export function getViewerEntry(
  authorship: PostAuthorshipEntry[],
  viewerId: string | undefined,
): PostAuthorshipEntry | undefined {
  if (!viewerId) return undefined;
  return authorship.find((entry) => entry.oxyUserId === viewerId);
}

export function isProfileVisible(authorship: PostAuthorshipEntry[], userId: string): boolean {
  const entry = getViewerEntry(authorship, userId);
  if (!entry) return false;
  if (entry.role === 'owner') return entry.status === 'accepted';
  return entry.role === 'collaborator' && entry.status === 'accepted';
}

export function getNotificationRecipients(authorship: PostAuthorshipEntry[]): string[] {
  const owner = getOwner(authorship);
  const ids = new Set<string>();
  if (owner?.oxyUserId) ids.add(owner.oxyUserId);
  for (const collab of getAcceptedCollaborators(authorship)) {
    ids.add(collab.oxyUserId);
  }
  return [...ids];
}

export function hasCollaborators(authorship: PostAuthorshipEntry[]): boolean {
  return authorship.some((entry) => entry.role === 'collaborator');
}

/**
 * Whether the post still has at least one collaborator invite awaiting a
 * response. Federation delivery is deferred while any invite is pending — the
 * post only fans out to the fediverse once every collaborator has accepted or
 * declined (resolved), so a collaborator's identity is never leaked before they
 * consent. Declined/stopped/accepted collaborators do NOT count as pending.
 */
export function hasPendingCollabInvites(authorship: PostAuthorshipEntry[]): boolean {
  return getPendingCollaborators(authorship).length > 0;
}

export function getHeaderAuthorshipEntries(authorship: PostAuthorshipEntry[]): PostAuthorshipEntry[] {
  const owner = getOwner(authorship);
  if (!owner) return [];
  return [owner, ...getAcceptedCollaborators(authorship)];
}

export function validateCollaboratorIds(ownerId: string, collaboratorIds: string[]): string[] {
  if (collaboratorIds.length > MAX_POST_COLLABORATORS) {
    throw new Error(`At most ${MAX_POST_COLLABORATORS} collaborators allowed`);
  }
  const unique = [...new Set(collaboratorIds.map((id) => id.trim()).filter(Boolean))];
  if (unique.includes(ownerId)) {
    throw new Error('Cannot invite yourself as a collaborator');
  }
  return unique;
}

export function collectAuthorshipUserIds(authorship: PostAuthorshipEntry[] | undefined, fallbackOwnerId?: string): string[] {
  const entries = normalizeAuthorship(authorship, fallbackOwnerId);
  const ids = new Set<string>();
  for (const entry of getHeaderAuthorshipEntries(entries)) {
    ids.add(entry.oxyUserId);
  }
  return [...ids];
}

export function buildAuthorFeedMatch(authorId: string): Record<string, unknown> {
  return {
    authorship: { $elemMatch: { oxyUserId: authorId, status: 'accepted' } },
  };
}

export function buildFollowedAuthorsMatch(authorIds: string[]): Record<string, unknown> {
  return {
    $or: [
      { oxyUserId: { $in: authorIds } },
      { authorship: { $elemMatch: { oxyUserId: { $in: authorIds }, status: 'accepted' } } },
    ],
  };
}
