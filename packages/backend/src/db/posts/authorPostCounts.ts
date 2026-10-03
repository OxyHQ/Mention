import { and, eq, sql } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';
import { getDb } from '../postgres';
import { posts } from '../schema/posts';
import { notCollapsedCrosspostSql } from '../../utils/feedQueryBuilder';

/** An author's public, published content, split the way the profile shows it. */
export interface AuthorPostCounts {
  /** Top-level posts — matches the author feed's `posts` tab. */
  postsCount: number;
  boostsCount: number;
  /** Posts that ARE replies — the inverse of `postsCount`. */
  repliesCount: number;
}

/**
 * ONE grouped pass over the author's public published posts, `filter`-ed per
 * bucket, rather than three COUNTs over the same index range. Read by the
 * profile page's stats and by the profile's structured data, so the number a
 * reader sees and the number a search engine is told cannot disagree.
 */
export async function countAuthorPublicPosts(oxyUserId: string): Promise<AuthorPostCounts> {
  const [counts] = await getDb()
    .select({
      // The STORED discriminator, not `parent_post_id IS NULL`: an orphaned
      // reply (parent deleted, `ON DELETE SET NULL` fired) is still a reply and
      // must not be counted as a top-level post here while the author feed's
      // `posts` tab — which reads the same column — leaves it out.
      postsCount: sql<number>`count(*) filter (where ${posts.isReply} = false)::int`,
      boostsCount: sql<number>`count(*) filter (where ${posts.type} = ${PostType.BOOST})::int`,
      repliesCount: sql<number>`count(*) filter (where ${posts.isReply})::int`,
    })
    .from(posts)
    .where(and(
      eq(posts.oxyUserId, oxyUserId),
      eq(posts.visibility, PostVisibility.PUBLIC),
      eq(posts.status, 'published'),
      notCollapsedCrosspostSql(),
    ));
  return {
    postsCount: counts?.postsCount ?? 0,
    boostsCount: counts?.boostsCount ?? 0,
    repliesCount: counts?.repliesCount ?? 0,
  };
}
