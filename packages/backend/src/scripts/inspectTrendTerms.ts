/**
 * Print what a term's posts actually STORE — the one question the public API
 * cannot answer.
 *
 * Written after six rounds of black-box elimination failed to explain why
 * `mention` was the network's biggest trend while appearing in no post's text,
 * no hashtag array, no topic list and no mention link. Every one of those was
 * ruled out through the API; the column that must therefore hold it —
 * `classification_trend_terms` — is the only one no endpoint exposes.
 *
 * Read-only. Prints, changes nothing.
 *
 *   bun packages/backend/dist/src/scripts/inspectTrendTerms.js <term> [limit]
 */

import { asc, desc, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { postContentVariants } from '../db/schema/postContent';
import { posts } from '../db/schema/posts';
import { logger } from '../utils/logger';
import { trendTermMatchSql } from '../services/trending/termSpace';

/** Posts sampled. Enough to see a pattern, small enough to read. */
const DEFAULT_LIMIT = 10;

/** Longest rendition body printed per variant. */
const VARIANT_TEXT_PREVIEW = 200;

async function main(): Promise<void> {
  const term = (process.argv[2] ?? '').trim().toLowerCase();
  const limit = Number(process.argv[3]) || DEFAULT_LIMIT;
  if (!term) {
    logger.error('[inspectTrendTerms] usage: inspectTrendTerms <term> [limit]');
    process.exit(1);
  }

  await connectPostgres();

  const db = getDb();
  // Shares the batch's own definition, so this cannot look somewhere the real
  // thing does not — the point is to find WHICH column carries the term.
  //
  // Ordered by `created_at` alone: `posts.id` mixes pre-cutover ObjectId hex
  // with post-cutover uuid v7, so it is not a chronological axis and adding it
  // as a tie-break would order a mixed sample worse, not better.
  const sampled = await db
    .select({
      id: posts.id,
      createdAt: posts.createdAt,
      hashtags: posts.hashtags,
      trendTerms: posts.classificationTrendTerms,
      topics: posts.classificationTopics,
      hashtagsNorm: posts.classificationHashtagsNorm,
      version: posts.classificationVersion,
      status: posts.classificationStatus,
    })
    .from(posts)
    .where(trendTermMatchSql(term))
    .orderBy(desc(posts.createdAt))
    .limit(limit);

  logger.info('[inspectTrendTerms] sampled posts', { term, count: sampled.length });

  for (const post of sampled) {
    // Which container actually carries it — the whole question.
    const carriedBy = [
      post.trendTerms?.includes(term) ? 'trendTerms' : null,
      post.hashtags?.includes(term) ? 'hashtags' : null,
      post.topics?.includes(term) ? 'topics' : null,
    ].filter(Boolean);

    // Every rendition, not just the primary: if the classifier read a different
    // string from the one the DTO renders, the difference is here. One query per
    // sampled post is fine at a default of ten and bounded by `limit`.
    const variants = await db
      .select({ source: postContentVariants.source, body: postContentVariants.body })
      .from(postContentVariants)
      .where(eq(postContentVariants.postId, post.id))
      .orderBy(asc(postContentVariants.position));

    logger.info('[inspectTrendTerms] post', {
      id: post.id,
      createdAt: post.createdAt.toISOString(),
      carriedBy,
      classifierVersion: post.version,
      status: post.status,
      variants: variants.map((variant) => ({
        source: variant.source,
        text: variant.body.slice(0, VARIANT_TEXT_PREVIEW),
        // Does the stored text contain the term AT ALL? A `false` here beside a
        // `trendTerms` hit is the whole finding.
        containsTerm: variant.body.toLowerCase().includes(term),
      })),
      trendTerms: post.trendTerms,
      hashtags: post.hashtags,
      hashtagsNorm: post.hashtagsNorm,
      topics: post.topics,
    });
  }

  // One-shot scripts MUST close their pool and exit: imported singletons (BullMQ
  // Redis connections, MediaCache workers) otherwise keep a Fargate task alive
  // forever. See AGENTS.md § one-shot scripts.
  await closePostgres();
  process.exit(0);
}

main().catch((error) => {
  logger.error('[inspectTrendTerms] failed', error);
  process.exit(1);
});
