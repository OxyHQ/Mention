/**
 * The other post pages that repeat a post's words or media, so they have to
 * leave the edge with it:
 *
 *  - a boost's page describes the boosted original (`webShellRenderer.mapPostOg`);
 *  - a quote with no text or media of its own borrows the quoted post's;
 *  - a post's page lists its newest replies as structured data, so a reply is
 *    also on its parent's page.
 *
 * Read WHILE THE LINKS ARE LIVE: a delete cascades `repost_of` and nulls
 * `quote_of` and `parent_post_id`, so a delete path reads this before it deletes.
 */
import { inArray, or } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres';
import { posts } from '../../db/schema/posts';

/**
 * Boosts and quotes read per call. A widely boosted post has as many boost pages
 * as boosters; past this the rest expire with `s-maxage`.
 */
export const DEPENDENT_PAGE_LIMIT = 500;

/** Ids of the pages that repeat any of `postIds`, without those ids themselves. */
export async function findDependentPostIds(
  postIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  if (postIds.length === 0) return [];
  const ids = [...postIds];

  const repeating = await db
    .select({ id: posts.id })
    .from(posts)
    .where(or(inArray(posts.repostOf, ids), inArray(posts.quoteOf, ids)))
    .limit(DEPENDENT_PAGE_LIMIT);
  const replies = await db
    .select({ parentPostId: posts.parentPostId })
    .from(posts)
    .where(inArray(posts.id, ids));

  const own = new Set(ids);
  const found = [...repeating.map((row) => row.id), ...replies.map((row) => row.parentPostId)];
  return [...new Set(found.filter((id): id is string => id !== null && !own.has(id)))];
}
