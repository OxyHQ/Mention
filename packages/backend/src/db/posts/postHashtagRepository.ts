/**
 * Reads over `post_hashtags`, the per-tag index of listed posts that migration
 * 0071's triggers keep current (and `scripts/backfillPostHashtags.ts` filled for
 * the posts written before it).
 *
 * A row exists only while its post is public, published and not a collapsed
 * crosspost variant, so membership IS the hashtag page's visibility scope.
 */

import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';

import { getDb } from '../postgres';
import { postHashtags } from '../schema/postContent';
import { posts } from '../schema/posts';
import { CHRONO_DESC, findPostRecords } from './postRepository';
import type { PostRecord } from './postRecord';

/** The tag rows a hashtag page reads: stored tags are lowercase. */
function hashtagRows(hashtag: string): SQL {
  return eq(postHashtags.tag, hashtag.toLowerCase());
}

/** The posts `post_hashtags` lists under the tag, as a predicate on `posts`. */
export function postsListedUnderHashtagSql(hashtag: string): SQL {
  return inArray(
    posts.id,
    getDb().select({ id: postHashtags.postId }).from(postHashtags).where(hashtagRows(hashtag)),
  );
}

/**
 * One chronological page of a hashtag: `limit` posts strictly older than
 * `boundary` (newest first when there is none).
 *
 * The page is chosen in `post_hashtags`, as one range of
 * `post_hashtags_tag_recent_idx` (tag, created_at desc, post_id desc) exactly as
 * long as the page, and only those posts are then read from `posts`. On
 * `posts.hashtags` the GIN index could find a tag's posts but not order them: a
 * common tag walked the public chronological index (17,881 rows for 21 kept,
 * 1.1 s cold) and a less common one sorted every match (1,061 heap pages,
 * 0.73 s cold; production, 2026-10-15). The rows copy their post's `created_at`,
 * so the boundary bounds the same order either side.
 */
export async function findHashtagPage(
  hashtag: string,
  boundary: { at: Date; id: string } | undefined,
  limit: number,
): Promise<PostRecord[]> {
  // A row comparison, so the bound is part of the index range rather than a
  // filter over every row of the tag newer than the cursor.
  const keyset = boundary
    ? sql`(${postHashtags.createdAt}, ${postHashtags.postId}) < (${boundary.at.toISOString()}::timestamptz, ${boundary.id})`
    : undefined;
  const page = getDb()
    .select({ id: postHashtags.postId })
    .from(postHashtags)
    .where(and(hashtagRows(hashtag), keyset))
    .orderBy(
      sql`${postHashtags.createdAt} desc nulls last`,
      sql`${postHashtags.postId} desc nulls last`,
    )
    .limit(limit);
  return findPostRecords(inArray(posts.id, page), { orderBy: CHRONO_DESC, limit });
}
