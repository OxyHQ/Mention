import type { PostAuthorshipEntry, PostAuthorRole, PostAuthorStatus } from '@mention/shared-types';
import { MAX_POST_COLLABORATORS } from '@mention/shared-types';
import { and, eq, exists, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { postAuthorships, posts } from '../db/schema';

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
 * "This post is authored by one of `authorIds`" — the port of Mongo's
 * `authorship: { $elemMatch: { oxyUserId: { $in: … }, status: 'accepted' } }`.
 *
 * `$elemMatch` means the two conditions must hold on the SAME array element, and
 * a correlated `EXISTS` over the `post_authorships` child table is that exact
 * semantics — a plain join would let a post match by pairing one collaborator's
 * id with a DIFFERENT entry's `accepted` status, which is the bug `$elemMatch`
 * exists to prevent and the reason this is not written as a join.
 *
 * `status = 'accepted'` is what keeps a PENDING collaborator invite off the
 * feed: an invitee must never appear as an author until they consent.
 *
 * Built through drizzle's query builder so the correlated
 * `post_authorships.post_id = posts.id` renders FULLY QUALIFIED. Hand-writing it
 * inside a `sql` template is the documented way to get two bare column names
 * that both resolve against the subquery's own table, matching nothing and
 * raising nothing (`db/casing.ts`).
 *
 * Returns a predicate matching NOTHING for an empty id list, which is the honest
 * answer and matches Mongo's `$in: []`.
 *
 * ## Channel posts are excluded unconditionally
 *
 * A post published to a CHANNEL belongs to the channel and only to the channel:
 * it never appears on its author's profile and never reaches their followers'
 * timeline. To put one on your own profile you BOOST it — a separate row, owned
 * by you, that says so.
 *
 * The exclusion lives HERE rather than at the call sites, so a new profile or
 * following query inherits it instead of having to remember it. Mongo spelled it
 * `{ channelId: { $exists: false } }` and had to keep it a flat conjunctive term,
 * because `ChronoCursor.applyToQuery` ASSIGNS `match.$or` and a disjunctive
 * spelling would have stopped filtering after page one — a channel post leaking
 * onto its author's profile only once the reader scrolled.
 *
 * `channel_id is null` carries no such hazard and is TOTAL: it matches every
 * post written before channels existed as well as every ordinary post, so there
 * is no backfill to do and no second clause to add. Mongo needed the note that
 * nothing may ever store an explicit `null` (it would satisfy `$exists` and
 * wrongly exclude the post); here `null` IS "no channel", so the two states
 * cannot diverge.
 */
export function followedAuthorsSql(authorIds: readonly string[]): SQL {
  if (authorIds.length === 0) return sql`false`;
  const authored = exists(
    getDb()
      .select({ one: sql`1` })
      .from(postAuthorships)
      .where(
        and(
          eq(postAuthorships.postId, posts.id),
          eq(postAuthorships.status, 'accepted'),
          inArray(postAuthorships.oxyUserId, [...authorIds]),
        ),
      ),
  );
  return and(authored, isNull(posts.channelId)) as SQL;
}

/** Single-author form of {@link followedAuthorsSql} — the profile feed's match. */
export function authorFeedSql(authorId: string): SQL {
  return followedAuthorsSql([authorId]);
}
