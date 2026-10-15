import { eq } from 'drizzle-orm';
import { getDb } from '../postgres';
import { authorPostCounts } from '../schema/posts';

/** An author's public, published content, split the way the profile shows it. */
export interface AuthorPostCounts {
  /** Top-level posts — matches the author feed's `posts` tab. */
  postsCount: number;
  boostsCount: number;
  /** Posts that ARE replies — the inverse of `postsCount`. */
  repliesCount: number;
}

/**
 * The author's counts, read from `author_post_counts` by primary key. Read by
 * the profile page's stats and by the profile's structured data, so the number a
 * reader sees and the number a search engine is told cannot disagree.
 *
 * Triggers on `posts` keep the row in step with the author's public, published,
 * uncollapsed posts (migration 0068). The buckets read the STORED `is_reply`,
 * not `parent_post_id IS NULL`: an orphaned reply (parent deleted,
 * `ON DELETE SET NULL` fired) is still a reply and must not be counted as a
 * top-level post while the author feed's `posts` tab — which reads the same
 * column — leaves it out. An author with no counted post has no row: zero.
 */
export async function countAuthorPublicPosts(oxyUserId: string): Promise<AuthorPostCounts> {
  const [counts] = await getDb()
    .select({
      postsCount: authorPostCounts.postsCount,
      boostsCount: authorPostCounts.boostsCount,
      repliesCount: authorPostCounts.repliesCount,
    })
    .from(authorPostCounts)
    .where(eq(authorPostCounts.oxyUserId, oxyUserId));
  return {
    postsCount: counts?.postsCount ?? 0,
    boostsCount: counts?.boostsCount ?? 0,
    repliesCount: counts?.repliesCount ?? 0,
  };
}
