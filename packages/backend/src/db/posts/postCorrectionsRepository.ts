/**
 * The public correction trail of a channel post.
 *
 * A channel is a publication, so its posts stay editable for their whole life
 * rather than for the 30 minutes a personal post gets. This module is what makes
 * that acceptable: every change to the body appends a row saying what the post
 * said BEFORE it, and the post carries a counter so a feed row can show the
 * marker without reading the trail.
 *
 * ## The counter is the source of the revision number
 *
 * `recordPostCorrection` increments `posts.correction_count` and takes the
 * returned value as the new `revision`, in ONE statement. Reading the count and
 * then writing `count + 1` would be the same value under a lock nobody took: two
 * concurrent corrections of one post would both read N, both write N+1, and the
 * unique `(post_id, revision)` index would turn the loser into a 500 on a save
 * the operator had every right to make. `update … returning` serializes them on
 * the row lock the update already takes, so the second correction gets N+2 and
 * both succeed.
 *
 * That is also why the counter is not an aggregate over this table: retention
 * deletes rows, so `count(*)` would go DOWN and start reissuing revision numbers
 * that already exist.
 */

import { and, asc, eq, gt, lt, sql } from 'drizzle-orm';
import type { PostCorrection } from '@mention/shared-types/post';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { postCorrections } from '../schema/postContent';
import { posts } from '../schema/posts';

/**
 * How many superseded bodies one post keeps.
 *
 * A ceiling, not an editorial policy: a publication correcting a post fifty
 * times is not a thing that happens, so this never bites real use — it exists so
 * a script hammering the edit route cannot grow one post's storage without
 * bound. Worst case per post is this many bodies, each capped by
 * `config.posts.maxTextLength`.
 *
 * Revision 1 is exempt from eviction (see {@link recordPostCorrection}), so the
 * retained set is the post AS PUBLISHED plus the most recent `N - 1` versions —
 * the two ends a reader actually asks for. Intermediate versions are what a cap
 * has to give up, and the surviving `revision` numbers say exactly which.
 */
export const MAX_RETAINED_POST_CORRECTIONS = 50;

/** What a recorded correction tells its caller. */
export interface RecordedPostCorrection {
  /** This correction's 1-based revision number. */
  revision: number;
  /** The post's new total — what the DTO's correction summary reports as `count`. */
  correctionCount: number;
  /** When it was recorded — the value written to both tables. */
  correctedAt: Date;
}

/**
 * Record that a post's body was corrected, and bound what is retained.
 *
 * Returns `null` when the post does not exist, which is the same answer the
 * caller's own load already gave — it cannot happen behind a successful edit and
 * is not worth a throw.
 *
 * The whole thing runs in ONE transaction so the counter and the row can never
 * disagree: a counter ahead of the rows would claim a version that is not there,
 * and a row ahead of the counter would hide a correction from every feed.
 */
export async function recordPostCorrection(
  params: {
    postId: string;
    /** The primary rendition as it read before this correction. */
    previousText: string;
    /** The human who made it. Stored for audit; never served. */
    correctedByOxyUserId: string;
    correctedAt: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<RecordedPostCorrection | null> {
  return db.transaction(async (tx) => {
    const [bumped] = await tx
      .update(posts)
      .set({
        correctionCount: sql`${posts.correctionCount} + 1`,
        lastCorrectedAt: params.correctedAt,
      })
      .where(eq(posts.id, params.postId))
      .returning({ correctionCount: posts.correctionCount });

    if (!bumped) return null;

    const revision = bumped.correctionCount;

    await tx.insert(postCorrections).values({
      postId: params.postId,
      revision,
      previousText: params.previousText,
      correctedByOxyUserId: params.correctedByOxyUserId,
      createdAt: params.correctedAt,
    });

    // Retention. The keeper set is `{1} ∪ {revision - (MAX - 2) … revision}`,
    // which is exactly MAX rows: revision 1 plus the most recent MAX - 1. So
    // everything strictly between them goes. Skipped entirely below the cap so
    // the ordinary correction costs one insert and no delete.
    if (revision > MAX_RETAINED_POST_CORRECTIONS) {
      const oldestRetainedRecent = revision - (MAX_RETAINED_POST_CORRECTIONS - 2);
      await tx
        .delete(postCorrections)
        .where(
          and(
            eq(postCorrections.postId, params.postId),
            gt(postCorrections.revision, 1),
            lt(postCorrections.revision, oldestRetainedRecent),
          ),
        );
    }

    return { revision, correctionCount: revision, correctedAt: params.correctedAt };
  });
}

/**
 * One post's readable trail, oldest first.
 *
 * `corrected_by_oxy_user_id` is NOT selected. That is the enforcement of the
 * writer-disclosure rule, not a comment about it: the column never enters a row
 * type this function can return, so a serializer that tried to ship it would
 * fail `tsc` rather than ship it.
 */
export async function listPostCorrections(
  postId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<PostCorrection[]> {
  const rows = await db
    .select({
      revision: postCorrections.revision,
      previousText: postCorrections.previousText,
      createdAt: postCorrections.createdAt,
    })
    .from(postCorrections)
    .where(eq(postCorrections.postId, postId))
    .orderBy(asc(postCorrections.revision));

  return rows.map((row) => ({
    revision: row.revision,
    previousText: row.previousText,
    correctedAt: row.createdAt.toISOString(),
  }));
}
