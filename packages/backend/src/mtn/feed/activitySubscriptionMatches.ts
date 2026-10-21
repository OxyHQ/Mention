import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { postAuthorships, postSubscriptions } from '../../db/schema';
import type { CandidatePost, FeedEngineContext } from './engine/types';

/** One bounded membership read for shell coauthors missed by the dedicated bell window. */
export async function activitySubscriptionMatches(
  posts: CandidatePost[],
  ctx: FeedEngineContext,
): Promise<Set<string>> {
  const ids = new Set(ctx.activitySubscribedAuthorIds ?? []);
  const matches = new Set<string>();
  if (!ctx.currentUserId || !ids.size) return matches;
  const unresolved: string[] = [];
  for (const post of posts) {
    if (
      post.activitySubscriptionMatch ||
      ids.has(post.oxyUserId ?? '') ||
      post.authorship.some((entry) => entry.status === 'accepted' && ids.has(entry.oxyUserId))
    )
      matches.add(post.id);
    else if (post._unassembled) unresolved.push(post.id);
  }
  if (!unresolved.length) return matches;
  const rows = await getDb()
    .selectDistinct({ id: postAuthorships.postId })
    .from(postAuthorships)
    .innerJoin(
      postSubscriptions,
      and(
        eq(postSubscriptions.authorId, postAuthorships.oxyUserId),
        eq(postSubscriptions.subscriberId, ctx.currentUserId),
      ),
    )
    .where(
      and(inArray(postAuthorships.postId, unresolved), eq(postAuthorships.status, 'accepted')),
    );
  for (const row of rows) matches.add(row.id);
  return matches;
}
