/**
 * Migration 0015: indexes for the on-demand `TrendSummary` collection.
 *
 * A trend summary is generated once a trend has been opened enough times to
 * justify the model call, and then served from storage. Two indexes carry that:
 *
 *  - UNIQUE `{ term: 1, runStartedAt: 1 }` — the identity of a summary, and the
 *    thing that makes generation idempotent BY CONSTRUCTION. Two tasks that
 *    cross the demand threshold in the same second both generate; without this
 *    index both would store, and the collection would grow one row per race
 *    while readers saw whichever the query happened to return. With it, one
 *    insert wins and the loser reads the winner's row. It also serves the read
 *    that runs on EVERY open of a trend — by far the hottest path here, since
 *    the overwhelming majority of opens find an existing summary.
 *  - `{ generatedAt: 1 }` with `expireAfterSeconds` — summaries are derived
 *    text, so the collection is bounded at the storage layer rather than by
 *    remembering to clean it up.
 *
 * The schema declares both, but `autoIndex`/`autoCreate` are OFF in production
 * (see `utils/database.ts`), so this migration is the only thing that creates
 * them.
 *
 * Idempotent and data-free: `createIndex` with an identical spec is a no-op, and
 * it creates the collection on first run. No backfill — there is nothing to
 * backfill, since a summary only ever exists because a reader asked for it.
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { MIGRATION_TREND_SUMMARY_INDEXES } from './constants';
import TrendSummaryModel, { TREND_SUMMARY_TTL_SECONDS } from '../models/TrendSummary';
import type { Migration } from './runner';

export const migrationTrendSummaryIndexes: Migration = {
  id: MIGRATION_TREND_SUMMARY_INDEXES,

  async run(db: mongoose.mongo.Db): Promise<void> {
    const summaries = db.collection(TrendSummaryModel.collection.collectionName);

    await summaries.createIndex({ term: 1, runStartedAt: 1 }, { unique: true });
    await summaries.createIndex(
      { generatedAt: 1 },
      { expireAfterSeconds: TREND_SUMMARY_TTL_SECONDS },
    );

    logger.info(
      `[migration] ensured indexes on ${summaries.collectionName}: ` +
        `{ term, runStartedAt } (unique) + { generatedAt } TTL ${TREND_SUMMARY_TTL_SECONDS}s`,
    );
  },
};
