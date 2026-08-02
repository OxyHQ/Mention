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
): PostAuthorshipEntry[] {
  return authorship && authorship.length > 0 ? authorship : [];
}

export function getOwner(authorship: PostAuthorshipEntry[]): PostAuthorshipEntry | undefined {
  return authorship.find((entry) => entry.role === 'owner');
}

export function getOwnerId(authorship: PostAuthorshipEntry[]): string | undefined {
  return getOwner(authorship)?.oxyUserId;
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

export function collectAuthorshipUserIds(authorship: PostAuthorshipEntry[] | undefined): string[] {
  const entries = normalizeAuthorship(authorship);
  const ids = new Set<string>();
  for (const entry of getHeaderAuthorshipEntries(entries)) {
    ids.add(entry.oxyUserId);
  }
  return [...ids];
}

/**
 * A post published to a channel belongs to the CHANNEL and only to the channel: it
 * never appears on its author's profile, and it never reaches their followers'
 * timeline. To put one on your own profile you BOOST it — a separate row, owned by
 * you, that says so.
 *
 * The exclusion is unconditional and lives in the two author-relationship matchers
 * below rather than at their call sites, so a new profile or following query
 * inherits it instead of having to remember it.
 *
 * **It is a flat conjunctive term, and it can never become an `$or`.**
 * `ChronoCursor.applyToQuery` ASSIGNS `match.$or` rather than merging into it, so
 * a disjunctive spelling of this filter would work on page one and then silently
 * stop filtering on every page after — a channel post leaking onto its author's
 * profile only once the reader scrolls. `$exists: false` also matches every post
 * written before channels existed, so no backfill is needed and no second clause
 * covers the ordinary post.
 *
 * A stored `null` would satisfy `$exists` and wrongly exclude the post, which is
 * why nothing ever writes one: `PostCreationService` sets `channelId` only when
 * there IS a channel, and the delete cascade `$unset`s it.
 */
export const EXCLUDE_CHANNEL_POSTS = { channelId: { $exists: false } } as const;

export function buildAuthorFeedMatch(authorId: string): Record<string, unknown> {
  return {
    authorship: { $elemMatch: { oxyUserId: authorId, status: 'accepted' } },
    ...EXCLUDE_CHANNEL_POSTS,
  };
}

export function buildFollowedAuthorsMatch(authorIds: string[]): Record<string, unknown> {
  return {
    authorship: { $elemMatch: { oxyUserId: { $in: authorIds }, status: 'accepted' } },
    ...EXCLUDE_CHANNEL_POSTS,
  };
}
