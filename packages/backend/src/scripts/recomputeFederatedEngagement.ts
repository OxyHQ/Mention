/**
 * One-shot reconciliation: recompute federated post engagement counters from the
 * REAL native records that back them.
 *
 * Federated/imported posts (those carrying a `federation.activityId`) once seeded
 * their `stats.likesCount/boostsCount/commentsCount` from remote aggregate totals
 * (`note.likes/shares/replies.totalItems`). Those foreign aggregates had no
 * backing listable records here, so the counters could diverge from reality.
 *
 * Engagement is now relational and native:
 *   - a like is a `Like` doc `{ userId, postId, value: 1 }`,
 *   - a boost is a `Post` with `type: 'boost'` and `boostOf == <post _id>`,
 *   - a comment is a reply `Post` with `parentPostId == <post _id>`.
 *
 * This script recomputes each federated post's counters from those records and
 * writes them back. It is idempotent (re-running over already-correct posts is a
 * no-op), batched via a stable `_id` cursor (the filter set never changes because
 * we only mutate `stats.*`), and logs progress plus a final summary of how many
 * posts were corrected and the total absolute drift removed.
 *
 * Runnable as a Fargate one-shot post-deploy:
 *   node dist/scripts/recomputeFederatedEngagement.js --dry-run
 *   node dist/scripts/recomputeFederatedEngagement.js
 */

import { and, asc, count, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { likes } from '../db/schema/engagement';
import { posts } from '../db/schema/posts';
import { logger } from '../utils/logger';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';

/** Posts scanned per page (stable `id` cursor pagination). */
const PAGE_SIZE = 500;

interface RealCounts {
  likesCount: number;
  boostsCount: number;
  commentsCount: number;
}

/**
 * Count the real records that back each engagement counter, for a WHOLE PAGE.
 *
 * Three grouped aggregates rather than three counts per post: the Mongo version
 * issued `3 × PAGE_SIZE` round trips per page, and this sweep is designed to walk
 * the entire federated corpus.
 */
async function computeRealCounts(postIds: string[]): Promise<Map<string, RealCounts>> {
  const db = getDb();
  const [likeRows, boostRows, commentRows] = await Promise.all([
    // Likes: native like rows (upvotes) for this post.
    //
    // This read was Mongo until it became a DEAD-STORE read.
    // `PostEngagementCommandService` has written `likes` to Postgres since
    // `28f4c6bd`, so nothing has written the Mongo collection since — and this
    // script does not merely READ stale, it recomputes counters and writes them
    // onto live posts. Left as it was, running it rewrote every federated post's
    // engagement to its value as of that commit, with no error anywhere.
    //
    // `value: 1` is the upvote half of the same `LIKE_VALUES` domain the CHECK
    // constrains; a downvote is a real row and must NOT be counted here.
    db
      .select({ id: likes.postId, count: count() })
      .from(likes)
      .where(and(inArray(likes.postId, postIds), eq(likes.value, 1)))
      .groupBy(likes.postId),
    // Boosts: native boost posts referencing this post.
    db
      .select({ id: posts.boostOf, count: count() })
      .from(posts)
      .where(and(inArray(posts.boostOf, postIds), eq(posts.type, 'boost')))
      .groupBy(posts.boostOf),
    // Comments: reply posts whose parent is this post.
    db
      .select({ id: posts.parentPostId, count: count() })
      .from(posts)
      .where(inArray(posts.parentPostId, postIds))
      .groupBy(posts.parentPostId),
  ]);

  const counts = new Map<string, RealCounts>();
  const entry = (id: string): RealCounts => {
    const existing = counts.get(id);
    if (existing) return existing;
    const created = { likesCount: 0, boostsCount: 0, commentsCount: 0 };
    counts.set(id, created);
    return created;
  };
  for (const row of likeRows) {
    if (row.id) entry(row.id).likesCount = row.count;
  }
  for (const row of boostRows) {
    if (row.id) entry(row.id).boostsCount = row.count;
  }
  for (const row of commentRows) {
    if (row.id) entry(row.id).commentsCount = row.count;
  }
  return counts;
}

async function recomputeFederatedEngagement(): Promise<void> {
  const startedAt = Date.now();
  const dryRun = process.argv.includes('--dry-run');

  try {
    assertAdminMutationAllowed({
      scriptName: 'recomputeFederatedEngagement',
      dryRun,
    });
    // ONE store now. Every record this reconciles against — posts, boosts,
    // replies and likes — is Postgres, so the Mongo connection is gone rather
    // than left open: an unused connection to a store nothing reads is how the
    // next reader concludes a read from it would still be valid.
    await connectPostgres();
    logger.info('[recomputeFederatedEngagement] connected to PostgreSQL', { dryRun });

    // `is not null`, never `<> null`: Mongo's `$ne: null` also matched an ABSENT
    // field, while SQL's `<>` against NULL matches nothing — the literal
    // translation would find zero federated posts and report a clean run.
    const federatedFilter = isNotNull(posts.federationActivityId);
    const [totals] = await getDb().select({ count: count() }).from(posts).where(federatedFilter);
    const totalCount = totals?.count ?? 0;
    logger.info(`[recomputeFederatedEngagement] ${totalCount} federated posts to scan`);

    if (totalCount === 0) {
      logger.info('[recomputeFederatedEngagement] nothing to do');
      return;
    }

    let scanned = 0;
    let changed = 0;
    let updated = 0;
    let totalDriftCorrected = 0;
    let lastId: string | null = null;
    const db = getDb();

    // Stable cursor: page by ascending id over the federated-post set. The set is
    // immutable for this run because only the counters are mutated.
    for (;;) {
      const page = await db
        .select({
          id: posts.id,
          likesCount: posts.statsLikesCount,
          boostsCount: posts.statsBoostsCount,
          commentsCount: posts.statsCommentsCount,
        })
        .from(posts)
        .where(lastId ? and(federatedFilter, gt(posts.id, lastId)) : federatedFilter)
        .orderBy(asc(posts.id))
        .limit(PAGE_SIZE);

      if (page.length === 0) break;

      const realByPost = await computeRealCounts(page.map((row) => row.id));

      for (const post of page) {
        const real = realByPost.get(post.id)
          ?? { likesCount: 0, boostsCount: 0, commentsCount: 0 };
        const current = {
          likesCount: post.likesCount,
          boostsCount: post.boostsCount,
          commentsCount: post.commentsCount,
        };

        const drift =
          Math.abs(current.likesCount - real.likesCount) +
          Math.abs(current.boostsCount - real.boostsCount) +
          Math.abs(current.commentsCount - real.commentsCount);

        if (drift > 0) {
          changed += 1;
          totalDriftCorrected += drift;
          if (!dryRun) {
            const corrected = await db
              .update(posts)
              .set({
                statsLikesCount: real.likesCount,
                statsBoostsCount: real.boostsCount,
                statsCommentsCount: real.commentsCount,
              })
              .where(eq(posts.id, post.id))
              .returning({ id: posts.id });
            updated += corrected.length;
          }
        }
      }

      scanned += page.length;
      lastId = page[page.length - 1].id;
      logger.info(
        `[recomputeFederatedEngagement] progress: scanned ${scanned}/${totalCount}, ` +
          `${dryRun ? 'would-correct' : 'corrected'} ${dryRun ? changed : updated}, ` +
          `drift ${dryRun ? 'found' : 'removed'} ${totalDriftCorrected}`,
      );
    }

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[recomputeFederatedEngagement] done (${dryRun ? 'DRY-RUN' : 'LIVE'}): scanned ${scanned}, ` +
        `${dryRun ? 'would-correct' : 'corrected'} ${dryRun ? changed : updated} posts, ` +
        `total drift ${dryRun ? 'found' : 'removed'} ${totalDriftCorrected} (${elapsedSeconds}s)`,
    );

  } catch (error) {
    logger.error('[recomputeFederatedEngagement] failed', error);
    process.exit(1);
  } finally {
    await closeAdminScriptResources().catch(() => undefined);
  }
}

if (require.main === module) {
  // Exit deterministically: imported singletons can keep the event loop alive, so
  // the process would otherwise sit RUNNING after the work completes. Mirrors
  // backfillFederatedBanners.
  recomputeFederatedEngagement()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[recomputeFederatedEngagement] unhandled failure', error);
      process.exit(1);
    });
}

export default recomputeFederatedEngagement;
