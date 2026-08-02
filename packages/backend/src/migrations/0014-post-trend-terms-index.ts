/**
 * Migration 0014: the trend-terms index on `posts`.
 *
 * Trend detection stopped being a ranking of the `hashtags` array and became a
 * measurement over `postClassification.trendTerms` — the words and phrases a
 * post is actually about. Two consumers read that field and BOTH are unusable
 * without an index on it:
 *
 *  - the 30-minute detection batch, which unwinds one trailing window of posts
 *    across every term at once, and
 *  - the `trend|<term>` feed, which pages a single term chronologically — the
 *    screen a reader lands on when they press a trend.
 *
 * `{ 'postClassification.trendTerms': 1, visibility: 1, status: 1, createdAt: -1 }`
 * serves both: the multikey array leads so a term is reached directly,
 * visibility+status narrow to what either consumer may count or serve, and
 * `createdAt` orders the batch's window and the feed's page from the index
 * rather than through a blocking sort. It mirrors `for_you_topics_idx` and
 * `for_you_language_idx`, which are the same shape over the sibling multikey
 * classification fields.
 *
 * The schema declares it, but `autoIndex`/`autoCreate` are OFF in production
 * (see `utils/database.ts`), so this migration is the only thing that creates
 * it.
 *
 * Idempotent and data-free: `createIndex` with an identical spec is a no-op, and
 * NO backfill is performed here. Posts written before term extraction simply
 * carry no `trendTerms`, which the detection batch already handles — it unions
 * the field with `hashtags` and `postClassification.topics`, so an old post
 * still contributes through those while the version-gated re-baseline populates
 * the field over time. A backfill inside a migration would be a full-corpus
 * write on the boot path of every task; that belongs in a one-shot task, not
 * here.
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { MIGRATION_POST_TREND_TERMS_INDEX } from './constants';
import { Post } from '../models/Post';
import type { Migration } from './runner';

export const migrationPostTrendTermsIndex: Migration = {
  id: MIGRATION_POST_TREND_TERMS_INDEX,

  async run(db: mongoose.mongo.Db): Promise<void> {
    const posts = db.collection(Post.collection.collectionName);
    await posts.createIndex(
      { 'postClassification.trendTerms': 1, visibility: 1, status: 1, createdAt: -1 },
      { name: 'trend_terms_idx' },
    );
    logger.info(
      `[migration] ensured index trend_terms_idx on ${posts.collectionName} ` +
        `{ postClassification.trendTerms: 1, visibility: 1, status: 1, createdAt: -1 }`,
    );
  },
};
