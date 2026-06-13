/**
 * Migration 0002: lowercase (and de-duplicate) post hashtags.
 *
 * Hashtags must be stored canonical lowercase so they match every read path:
 *   - `getPostsByHashtag` queries `hashtags: { $in: [hashtag.toLowerCase()] }`
 *   - the MTN `HashtagFeed` normalizes its tag via `tag.toLowerCase()`
 *   - the trending/search aggregations group with `$toLower`
 *
 * Both write paths now lowercase on write (`mergeHashtags` and
 * `FederationService.extractApHashtags`), but documents created before that fix
 * still carry mixed-case tags (e.g. `Cat`, `Art`, `Cartoon`) that can never
 * match a lowercased query. This migration rewrites the existing data.
 *
 * For every post whose `hashtags` is a non-empty array, it lowercases each
 * element and removes duplicates that collapse after lowercasing
 * (e.g. `['Cat', 'cat']` -> `['cat']`). The rewrite runs server-side via an
 * aggregation-pipeline update so no documents are pulled to the application.
 *
 * `$setUnion` both de-duplicates and sorts; hashtag ordering is irrelevant to
 * `$in` matching, so the sort is harmless. The operation is idempotent:
 * re-running it over already-lowercase, already-deduplicated arrays is a no-op
 * (the value is unchanged, so `modifiedCount` is 0).
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { MIGRATION_LOWERCASE_HASHTAGS } from './constants';
import type { Migration } from './runner';

export const migrationLowercaseHashtags: Migration = {
  id: MIGRATION_LOWERCASE_HASHTAGS,

  async run(db: mongoose.mongo.Db): Promise<void> {
    const posts = db.collection('posts');

    const result = await posts.updateMany(
      { hashtags: { $exists: true, $not: { $size: 0 }, $type: 'array' } },
      [
        {
          $set: {
            hashtags: {
              $setUnion: [
                {
                  $map: {
                    input: '$hashtags',
                    as: 'h',
                    in: { $toLower: '$$h' },
                  },
                },
                [],
              ],
            },
          },
        },
      ],
    );

    logger.info(
      `[migration] posts hashtags lowercase matched=${result.matchedCount} modified=${result.modifiedCount}`,
    );
  },
};
