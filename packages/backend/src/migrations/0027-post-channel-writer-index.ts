/**
 * Migration 0027: `post_channel_writer_v1` on `posts`.
 *
 * A channel that names the people who write for it gains a list of them on its
 * page, and that list is derived from posts rather than from the account's member
 * roll: the distinct `writtenByOxyUserId` values on the channel's public,
 * published posts. Without an index, answering it means walking every post that
 * channel has ever published and fetching each document to read a field the
 * existing author indexes do not carry.
 *
 * `{ oxyUserId: 1, visibility: 1, status: 1, writtenByOxyUserId: 1, createdAt: -1 }`
 * serves it end to end: the three equality terms make the channel's signed posts
 * one contiguous range, `writtenByOxyUserId` is the aggregation's group key, and
 * `createdAt` is the value it takes the max of — so both values the `$group`
 * reads live in the index and no post document is fetched.
 *
 * `partialFilterExpression`, NOT `sparse`, for the reason `0023-post-lane-index`
 * documents: Mongo indexes a document in a SPARSE compound index when ANY indexed
 * key is present, and every post has `visibility`, `status` and `createdAt`, so
 * `sparse` would index the whole collection and buy nothing.
 *
 * And `{ $type: 'string' }` rather than `{ $exists: true }`, which is the sharper
 * end of the same rule: a stored `null` SATISFIES `$exists`, so an `$exists`
 * filter would quietly admit any post whose writer field was cleared by assignment
 * rather than unset. `$type` excludes both shapes and does not depend on every
 * future writer of that field getting the clearing idiom right. The route's query
 * carries the same `{ $type: 'string' }` term so the planner can prove its
 * predicate is a subset of the filter — an `$exists: true` query term would NOT
 * make this index eligible.
 *
 * The schema declares it, but `autoIndex`/`autoCreate` are OFF in production (see
 * `utils/database.ts`), so this migration is the only thing that creates it. It is
 * deliberately NOT an entry in `POST_HOT_PATH_INDEXES`: that array is migration
 * `0010`'s payload, `0010` is already applied, and the runner skips an applied
 * migration — so an entry there would be a silent no-op in production.
 *
 * Idempotent and data-free: `createIndex` with an identical spec is a no-op, and
 * nothing is backfilled — a post published by a person signed in as themselves
 * carries no `writtenByOxyUserId`, which is exactly what the partial filter
 * excludes.
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { MIGRATION_POST_CHANNEL_WRITER_INDEX } from './constants';
import { Post } from '../models/Post';
import type { Migration } from './runner';

export const migrationPostChannelWriterIndex: Migration = {
  id: MIGRATION_POST_CHANNEL_WRITER_INDEX,

  async run(db: mongoose.mongo.Db): Promise<void> {
    const posts = db.collection(Post.collection.collectionName);
    await posts.createIndex(
      { oxyUserId: 1, visibility: 1, status: 1, writtenByOxyUserId: 1, createdAt: -1 },
      {
        name: 'post_channel_writer_v1',
        partialFilterExpression: { writtenByOxyUserId: { $type: 'string' } },
      },
    );
    logger.info(
      `[migration] ensured index post_channel_writer_v1 on ${posts.collectionName} ` +
        '{ oxyUserId: 1, visibility: 1, status: 1, writtenByOxyUserId: 1, createdAt: -1 } ' +
        "partial on { writtenByOxyUserId: { $type: 'string' } }",
    );
  },
};
