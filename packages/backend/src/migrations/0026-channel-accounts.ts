/**
 * Migration 0026: retire the Mention-local channel, and re-key `lanes` onto a
 * single owner.
 *
 * A channel is an Oxy ACCOUNT now (`kind: 'channel'`), so a channel post is
 * AUTHORED BY it: `Post.oxyUserId` and `Post.authorship` hold the channel, and the
 * human who wrote it is recorded outside `authorship` in `writtenByOxyUserId`.
 * Everything this migration removes existed only to express the previous shape,
 * where a channel was a Mention row and the post was authored by a person.
 *
 * FOUR groups of operations, in the order they must happen:
 *
 *  1. **The `lanes` indexes are re-created on `{ ownerId }` alone** and the three
 *     `{ ownerType, ownerId, … }` forms dropped. `ownerType` existed because a
 *     channel id came from a different id space than an `oxyUserId`; now it has
 *     one reachable value, and a single-valued discriminator is a branch every
 *     reader has to prove is dead. **The unique index is created BEFORE the old
 *     one is dropped**, so there is no window in which two concurrent creates of
 *     the same lane name are unconstrained — and creating it first is also what
 *     surfaces a genuine duplicate as a failed migration rather than as silent
 *     data loss. A duplicate is only possible if one publisher held the same lane
 *     name under two owner types, which the old `{ownerType, ownerId}` scoping
 *     made possible in principle and which no row can actually have, since every
 *     lane written to date is `ownerType: 'user'`.
 *  2. **`ownerType` is unset from every `lanes` row.** After the index re-key
 *     nothing reads it; leaving it would make a `lanes` document disagree with its
 *     own schema forever.
 *  3. **The migration refuses to run while any legacy channel post exists, then
 *     drops `post_channel_chrono_v1`.** `channelId` was the only marker keeping a
 *     person-authored channel post off that person's profile and follower feeds.
 *     Deleting it would disclose the writer, so those posts must be migrated to
 *     provisioned Oxy channel accounts (or explicitly removed) first.
 *  4. **The three channel collections are DROPPED** (`channels`,
 *     `channelmembers`, `channelfollows`). Membership lives in Oxy's account
 *     graph and a follow is an ordinary Oxy follow, so nothing here has a reader
 *     any more.
 *
 * Rewriting legacy channel posts is not something this migration can do: their
 * replacement Oxy channel accounts must be provisioned first. The preflight is
 * therefore deliberately fail-closed and runs before ANY destructive operation.
 *
 * Idempotent: `createIndex` with an identical spec is a no-op, `dropIndex` and
 * `drop` tolerate an absent target (checked, not assumed — see `dropIfPresent`),
 * and the lane `$unset` matches nothing after the first successful run.
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { MIGRATION_CHANNEL_ACCOUNTS } from './constants';
import { Lane } from '../models/Lane';
import { Post } from '../models/Post';
import type { Migration } from './runner';

/** Index names `0022-lane-indexes` created, which Mongo derived from their keys. */
const LEGACY_LANE_INDEXES = [
  'ownerType_1_ownerId_1_createdAt_-1',
  'ownerType_1_ownerId_1_nameLower_1',
  'ownerType_1_ownerId_1_displayMode_1',
] as const;

/** Collections that existed only to hold the Mention-local channel. */
const RETIRED_COLLECTIONS = ['channels', 'channelmembers', 'channelfollows'] as const;

/**
 * Drop an index only if it is actually there.
 *
 * `dropIndex` on a missing index raises `IndexNotFound` (code 27), and a
 * migration that throws on its second run is not idempotent — it would block
 * every later migration on any database where this one already succeeded.
 * Listing first is cheap and says exactly what happened, which a swallowed error
 * would not.
 */
async function dropIndexIfPresent(
  collection: mongoose.mongo.Collection,
  name: string,
): Promise<boolean> {
  const exists = await collection.indexExists(name);
  if (!exists) return false;
  await collection.dropIndex(name);
  return true;
}

export const migrationChannelAccounts: Migration = {
  id: MIGRATION_CHANNEL_ACCOUNTS,

  async run(db: mongoose.mongo.Db): Promise<void> {
    const posts = db.collection(Post.collection.collectionName);
    const legacyChannelPost = await posts.findOne(
      { channelId: { $exists: true } },
      { projection: { _id: 1, channelId: 1 } },
    );
    if (legacyChannelPost) {
      throw new Error(
        'Migration 0026 cannot retire channels while legacy channel posts exist; ' +
          'migrate them to provisioned Oxy channel accounts or explicitly remove them first',
      );
    }

    const lanes = db.collection(Lane.collection.collectionName);

    // New first, old second — see the docstring: the unique constraint must never
    // be absent, not even for the duration of this migration.
    await lanes.createIndex({ ownerId: 1, createdAt: -1 });
    await lanes.createIndex({ ownerId: 1, nameLower: 1 }, { unique: true });
    await lanes.createIndex({ ownerId: 1, displayMode: 1 });

    const droppedLaneIndexes: string[] = [];
    for (const name of LEGACY_LANE_INDEXES) {
      if (await dropIndexIfPresent(lanes, name)) droppedLaneIndexes.push(name);
    }

    const unsetOwnerType = await lanes.updateMany(
      { ownerType: { $exists: true } },
      { $unset: { ownerType: '' } },
    );

    const droppedPostIndex = await dropIndexIfPresent(posts, 'post_channel_chrono_v1');

    const droppedCollections: string[] = [];
    for (const name of RETIRED_COLLECTIONS) {
      // `listCollections` rather than a bare `drop()` in a try: a drop of a
      // missing collection answers `false` on some drivers and throws
      // `NamespaceNotFound` on others, and a migration should not depend on which.
      const [present] = await db.listCollections({ name }, { nameOnly: true }).toArray();
      if (!present) continue;
      await db.dropCollection(name);
      droppedCollections.push(name);
    }

    logger.info('[migration] retired the Mention-local channel', {
      laneIndexesCreated: ['ownerId_1_createdAt_-1', 'ownerId_1_nameLower_1', 'ownerId_1_displayMode_1'],
      laneIndexesDropped: droppedLaneIndexes,
      lanesOwnerTypeUnset: unsetOwnerType.modifiedCount,
      postChannelIndexDropped: droppedPostIndex,
      collectionsDropped: droppedCollections,
    });
  },
};
