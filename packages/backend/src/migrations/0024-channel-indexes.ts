/**
 * Migration 0024: every index Channels needs — its three new collections, and the
 * one partial index on `posts`.
 *
 * `channels`:
 *  - `{ handleLower: 1 }` UNIQUE — the channel's GLOBAL identity and the
 *    `/c/<handle>` lookup. This constraint IS the 409 on create and on rename:
 *    the pre-check that looks for the handle is not a lock.
 *  - `{ ownerOxyUserId: 1, createdAt: -1 }` — an owner's own channels.
 *  - `{ visibility: 1, followerCount: -1, _id: -1 }` — the directory's keyset.
 *
 * `channelmembers`:
 *  - `{ channelId: 1, oxyUserId: 1 }` UNIQUE — one membership per pair, which is
 *    what makes a repeated invite a 409 rather than a second row.
 *  - `{ channelId: 1, status: 1 }` — the member list and the member count.
 *  - `{ oxyUserId: 1, status: 1 }` — "which channels may I publish to", read by the
 *    composer's destination picker AND by the publish-time authorization check.
 *
 * `channelfollows`:
 *  - `{ oxyUserId: 1, channelId: 1 }` UNIQUE — the row's identity, which makes
 *    following idempotent.
 *  - `{ channelId: 1, notify: 1, _id: 1 }` — the notification fan-out's keyset, so
 *    a large channel is WALKED rather than loaded.
 *
 * `posts`:
 *  - `post_channel_chrono_v1`, PARTIAL on `{ channelId: { $type: 'string' } }` —
 *    the channel page, served from the index instead of a collection scan.
 *
 * The three collections are new and empty, so their unique constraints have
 * nothing to conflict with. The `posts` index is the only one touching a large
 * collection; it is in this same migration rather than split out because it is
 * created by the same feature landing in the same deploy and there is no
 * intermediate state in which one is wanted without the other.
 *
 * `partialFilterExpression`, NOT `sparse`: Mongo indexes a document in a SPARSE
 * compound index when ANY indexed key is present, and every post has `visibility`,
 * `status` and `createdAt` — so `sparse` would index the whole collection and save
 * nothing. Precedent for the partial form: `MTN_RECORD_ID_INDEX` in
 * `indexes/manifest.ts`, and `post_lane_chrono_v1` in migration 0023.
 *
 * The schemas declare all eight, but `autoIndex`/`autoCreate` are OFF in
 * production (see `utils/database.ts`), so this migration is the only thing that
 * creates them — the same relationship `0014-post-trend-terms-index` documents. It
 * is deliberately NOT an entry in `POST_HOT_PATH_INDEXES`: that array is migration
 * 0010's payload, 0010 is already recorded applied, and the runner skips an
 * applied migration — so an entry there would be a silent no-op in production.
 *
 * Idempotent and data-free: `createIndex` with an identical spec is a no-op, it
 * creates a collection on first run, and nothing is backfilled — a post written
 * before channels existed simply carries no `channelId`, which is exactly what the
 * partial filter excludes.
 *
 * HISTORY: the three collections and the `posts` field this created were removed
 * by `0026-channel-accounts`, when a channel became an Oxy account rather than a
 * Mention row. This migration is kept, and does exactly what it always did, so a
 * database's ledger still tells the truth about what ran on it — an already-applied
 * migration is skipped forever, so rewriting one to "not have happened" only
 * changes what a FRESH database does. The collection names are literals now
 * because the models they came from are gone; they are the same names Mongoose
 * derived from `Channel` / `ChannelMember` / `ChannelFollow`.
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { MIGRATION_CHANNEL_INDEXES } from './constants';
import { Post } from '../models/Post';
import type { Migration } from './runner';

export const migrationChannelIndexes: Migration = {
  id: MIGRATION_CHANNEL_INDEXES,

  async run(db: mongoose.mongo.Db): Promise<void> {
    const channels = db.collection('channels');
    await channels.createIndex({ handleLower: 1 }, { unique: true });
    await channels.createIndex({ ownerOxyUserId: 1, createdAt: -1 });
    await channels.createIndex({ visibility: 1, followerCount: -1, _id: -1 });

    const members = db.collection('channelmembers');
    await members.createIndex({ channelId: 1, oxyUserId: 1 }, { unique: true });
    await members.createIndex({ channelId: 1, status: 1 });
    await members.createIndex({ oxyUserId: 1, status: 1 });

    const follows = db.collection('channelfollows');
    await follows.createIndex({ oxyUserId: 1, channelId: 1 }, { unique: true });
    await follows.createIndex({ channelId: 1, notify: 1, _id: 1 });

    const posts = db.collection(Post.collection.collectionName);
    await posts.createIndex(
      { channelId: 1, visibility: 1, status: 1, createdAt: -1, _id: -1 },
      {
        name: 'post_channel_chrono_v1',
        partialFilterExpression: { channelId: { $type: 'string' } },
      },
    );

    logger.info(
      `[migration] ensured indexes on ${channels.collectionName} ` +
        '{ handleLower } (unique), { ownerOxyUserId, createdAt }, ' +
        `{ visibility, followerCount, _id }; on ${members.collectionName} ` +
        '{ channelId, oxyUserId } (unique), { channelId, status }, { oxyUserId, status }; ' +
        `on ${follows.collectionName} { oxyUserId, channelId } (unique), ` +
        `{ channelId, notify, _id }; and post_channel_chrono_v1 on ${posts.collectionName} ` +
        "{ channelId: 1, visibility: 1, status: 1, createdAt: -1, _id: -1 } partial on { channelId: { $type: 'string' } }",
    );
  },
};
