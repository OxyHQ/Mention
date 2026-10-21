import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { postAuthorships, postSubscriptions } from '../../db/schema';
import { eligibleActivitySubscriptionAuthors } from '../../services/activitySubscriptionInterest';
import type { CandidatePost, FeedEngineContext } from './engine/types';

/** One bounded membership read for shell coauthors missed by the dedicated bell window. */
export async function activitySubscriptionMatches(
  posts: CandidatePost[],
  ctx: FeedEngineContext,
): Promise<Map<string, string[]>> {
  const ids = new Set(
    eligibleActivitySubscriptionAuthors(
      ctx.activitySubscribedAuthorIds,
      ctx.userBehavior,
      ctx.viewerPrivacy?.blockedIds,
    ),
  );
  const matches = new Map<string, string[]>();
  if (!ctx.currentUserId || !ids.size) return matches;
  const unresolved: string[] = [];
  for (const post of posts) {
    const authors = [
      ...new Set([
        post.oxyUserId ?? '',
        ...post.authorship
          .filter((entry) => entry.status === 'accepted')
          .map((entry) => entry.oxyUserId),
      ]),
    ].filter((id) => ids.has(id));
    if (authors.length) matches.set(post.id, authors);
    else if (post._unassembled) unresolved.push(post.id);
  }
  if (!unresolved.length) return matches;
  const rows = await getDb()
    .selectDistinct({ id: postAuthorships.postId, authorId: postAuthorships.oxyUserId })
    .from(postAuthorships)
    .innerJoin(
      postSubscriptions,
      and(
        eq(postSubscriptions.authorId, postAuthorships.oxyUserId),
        eq(postSubscriptions.subscriberId, ctx.currentUserId),
      ),
    )
    .where(
      and(
        inArray(postAuthorships.postId, unresolved),
        inArray(postSubscriptions.authorId, [...ids]),
        eq(postAuthorships.status, 'accepted'),
      ),
    );
  for (const row of rows) matches.set(row.id, [...(matches.get(row.id) ?? []), row.authorId]);
  return matches;
}
