/**
 * Migration 0025: `channel_follow_by_user_v1` on `channelfollows`.
 *
 * `GET /channels/following` pages the reader's own subscriptions by keyset on
 * `{ createdAt: -1, _id: -1 }` within one `oxyUserId`, and
 * `{ oxyUserId: 1, createdAt: -1, _id: -1 }` serves that end to end: the reader is
 * reached directly, and the page is ordered from the index instead of through a
 * blocking sort. `_id` is IN the index rather than left as a tiebreak, because a
 * keyset cursor cannot rely on an ordering the index does not actually produce.
 *
 * Neither existing index can serve it. `{oxyUserId, channelId}` orders by
 * `channelId`, which bears no relation to when the reader followed;
 * `{channelId, notify, _id}` is keyed the other way round, for the notification
 * fan-out over ONE channel's followers.
 *
 * **Deliberately its own migration rather than an edit to `0024-channel-indexes`.**
 * The runner records an applied migration and skips it forever (`runner.ts`), so
 * appending to 0024 would be a silent no-op on any database that has already run
 * it — the exact trap `POST_HOT_PATH_INDEXES` documents for migration 0010. That
 * 0024 has not reached production yet does not make editing it safe: it has
 * plausibly run on a developer's machine, and a migration that creates different
 * indexes depending on when you first ran it is worse than an extra file.
 *
 * `autoIndex`/`autoCreate` are OFF in production (see `utils/database.ts`), so
 * this migration is the only thing that creates it.
 *
 * Idempotent and data-free: `createIndex` with an identical spec is a no-op, and
 * nothing is backfilled — every existing follow row already carries the
 * `createdAt` the index orders by.
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { MIGRATION_CHANNEL_FOLLOW_USER_INDEX } from './constants';
import { ChannelFollow } from '../models/ChannelFollow';
import type { Migration } from './runner';

export const migrationChannelFollowUserIndex: Migration = {
  id: MIGRATION_CHANNEL_FOLLOW_USER_INDEX,

  async run(db: mongoose.mongo.Db): Promise<void> {
    const follows = db.collection(ChannelFollow.collection.collectionName);
    await follows.createIndex(
      { oxyUserId: 1, createdAt: -1, _id: -1 },
      { name: 'channel_follow_by_user_v1' },
    );
    logger.info(
      `[migration] ensured index channel_follow_by_user_v1 on ${follows.collectionName} ` +
        '{ oxyUserId: 1, createdAt: -1, _id: -1 }',
    );
  },
};
