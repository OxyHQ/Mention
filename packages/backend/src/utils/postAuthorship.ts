import type { PostAuthorshipEntry, PostAuthorRole, PostAuthorStatus } from '@mention/shared-types';
import { MAX_POST_COLLABORATORS } from '@mention/shared-types';
import { and, eq, exists, inArray, or, sql, type SQL } from 'drizzle-orm';
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
 * ## There is deliberately NO channel exclusion here, and re-adding one would be a symptom rather than a fix
 *
 * A channel post used to be authored by the PERSON who wrote it and marked with a
 * `channel_id`, so a flat `channel_id is null` term was the only thing keeping it
 * off that person's own profile and out of their followers' timelines. A channel
 * is an Oxy ACCOUNT now and AUTHORS its own posts, so the `post_authorships`
 * clause below excludes it by construction — the writer is recorded in
 * `posts.written_by_oxy_user_id`, which these matchers never look at. The column,
 * its partial index and the term were all dropped by
 * `0017_a_channel_is_an_account`.
 *
 * That makes `posts.written_by_oxy_user_id` load-bearing: fold it into
 * `post_authorships` and every channel post reappears on its writer's surfaces
 * with nothing left to stop it.
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
  return authored;
}

/**
 * The profile feed's match: "this post is `authorId`'s" — the SPECIFICATION.
 *
 * Production no longer executes this predicate. `fetchAuthored`
 * (`mtn/feed/engine/sources/userSources.ts`) reaches the same posts down two
 * separately-indexed branches, because a single `or` gives the planner only one
 * usable ordering index and the other half degrades into a probe-per-candidate
 * walk. This stays as the statement of WHAT that decomposition has to mean, and
 * `__tests__/authorshipChronoSync.test.ts` asserts the two select the same rows
 * over the fixtures that distinguish them. Keeping the rule written once, in one
 * expression, is what makes "the fast path is still correct" a checkable claim
 * rather than a reading of two branches and a `union`.
 *
 * The `post_authorships` `EXISTS` is the AUTHORITY and stays exactly as
 * {@link followedAuthorsSql} writes it. The `oxy_user_id` term in front of it is
 * a second, cheaper way to reach the same posts, and it is here for two distinct
 * reasons — one of them a correctness fix, not an optimisation.
 *
 * ## It is a SUPERSET, which is what makes it safe
 *
 * `posts.oxy_user_id` is the denormalized owner (`db/schema/postContent.ts`:
 * exactly one `owner`, always `accepted`, mirrored onto the post). So under that
 * invariant the two terms select the same owner rows and this changes nothing.
 * Written as an `or`, a DRIFTED mirror cannot cost a row either way: a post whose
 * mirror is NULL or stale is still found by the `EXISTS`, and a post whose
 * authorship row is missing is still found by the mirror. That direction matters
 * because the failure being fixed is posts MISSING from their author's own
 * profile — a formulation that trades the `EXISTS` for the mirror (or narrows it
 * to `role = 'collaborator'`) is faster still and silently drops exactly the
 * drifted rows, which is the bug wearing the fix's clothes.
 *
 * ## The correctness half
 *
 * `insertChildRows` writes authorship rows only `if (authorship.length > 0)`, so
 * a post created with an empty authorship list — and any Mongo document that
 * backfilled from one — has an `oxy_user_id` and NO `post_authorships` row at
 * all. The `EXISTS` alone cannot see those, so they are invisible on their own
 * author's profile. This term is what serves them.
 *
 * ## The performance half
 *
 * The `EXISTS` alone gives the planner no index that connects "this author" to
 * "newest first", so it walks a chronological index over the whole table probing
 * `post_authorships` once per candidate. Measured on 624k posts, page of 21:
 *
 *   author with 2,003 posts    84–99 ms  →  2.3–4.2 ms   (the common case)
 *   author with 20,000 posts   3.7–6.0 ms → 10.5–15.6 ms  (a REGRESSION, kept)
 *
 * The regression is real and deliberate: the second shape is an account owning a
 * measurable fraction of all recent posts, where the probe-as-you-scan plan
 * happens to hit matches immediately. Trading ~5 ms there for ~90 ms on the
 * ordinary case is the right side of that trade, and both land in single or low
 * double digit milliseconds. Removing the regression entirely needs
 * `posts.created_at` denormalized onto `post_authorships` with a
 * `(oxy_user_id, status, post_created_at desc, post_id desc)` index — measured
 * at 0.58 ms / 0.93 ms for the two shapes — which is a migration, not a
 * predicate change.
 *
 * ## Channel posts stay excluded, and not by accident
 *
 * A channel post's `oxy_user_id` is the CHANNEL account; the human is in
 * `written_by_oxy_user_id`, which this term does not read. So the exclusion
 * {@link followedAuthorsSql} documents survives — asserted, not assumed, in
 * `__tests__/authorFeedMatch.test.ts`.
 */
export function authorFeedSql(authorId: string): SQL {
  return or(eq(posts.oxyUserId, authorId), followedAuthorsSql([authorId])) as SQL;
}
