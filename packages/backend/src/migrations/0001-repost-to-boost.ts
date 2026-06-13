/**
 * Migration 0001: rename "repost" -> "boost" across all collections.
 *
 * The application code has been fully migrated to the "boost" vocabulary with
 * NO backward-compatibility reads. This migration rewrites existing documents
 * so they match the new schema:
 *
 *   Post:
 *     - field  repostOf            -> boostOf
 *     - field  stats.repostsCount  -> stats.boostsCount
 *     - field  metadata.isReposted -> metadata.isBoosted
 *     - value  type 'repost'       -> type 'boost'
 *     - drop any stale index whose key references repostOf (the Mongoose schema
 *       recreates the equivalent boostOf indexes on boot).
 *   UserSettings:
 *     - field  notificationPreferences.reposts -> notificationPreferences.boosts
 *   Analytics:
 *     - field  stats.engagement.reposts -> stats.engagement.boosts
 *   UserBehavior:
 *     - field  preferredAuthors[].interactionTypes.reposts -> ...boosts
 *   Notification:
 *     - value  type 'repost' -> type 'boost'
 *
 * The Post model stores no MTN URI/collection strings on its documents (MTN
 * URIs are derived on demand), so there are no `mtn.social.repost` strings to
 * rewrite in this collection.
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { MIGRATION_REPOST_TO_BOOST } from './constants';
import type { Migration } from './runner';

const STALE_REPOST_INDEX_KEY = 'repostOf';

/**
 * Drop any index on the given collection whose key references the old
 * `repostOf` field. Missing indexes are ignored; unrelated errors are rethrown.
 */
async function dropStaleRepostIndexes(collection: mongoose.mongo.Collection): Promise<number> {
  let indexes: Array<{ name: string; key: Record<string, unknown> }>;
  try {
    indexes = (await collection.indexes()) as Array<{ name: string; key: Record<string, unknown> }>;
  } catch (error) {
    // A namespace-not-found error means the collection has no indexes yet.
    if (error instanceof mongoose.mongo.MongoServerError && error.codeName === 'NamespaceNotFound') {
      return 0;
    }
    throw error;
  }

  let dropped = 0;
  for (const index of indexes) {
    const referencesRepostOf = Object.keys(index.key).includes(STALE_REPOST_INDEX_KEY);
    if (!referencesRepostOf) continue;

    try {
      await collection.dropIndex(index.name);
      dropped += 1;
      logger.info(`[migration] dropped stale index ${index.name} on ${collection.collectionName}`);
    } catch (error) {
      // IndexNotFound means it was already gone — safe to ignore. Anything else is fatal.
      if (error instanceof mongoose.mongo.MongoServerError && error.codeName === 'IndexNotFound') {
        continue;
      }
      throw error;
    }
  }
  return dropped;
}

export const migrationRepostToBoost: Migration = {
  id: MIGRATION_REPOST_TO_BOOST,

  async run(db: mongoose.mongo.Db): Promise<void> {
    const posts = db.collection('posts');
    const userSettings = db.collection('usersettings');
    const analytics = db.collection('analytics');
    const userBehaviors = db.collection('userbehaviors');
    const notifications = db.collection('notifications');

    // --- Post: rename fields ---
    const postRename = await posts.updateMany(
      {},
      {
        $rename: {
          repostOf: 'boostOf',
          'stats.repostsCount': 'stats.boostsCount',
          'metadata.isReposted': 'metadata.isBoosted',
        },
      },
    );
    logger.info(
      `[migration] posts field rename matched=${postRename.matchedCount} modified=${postRename.modifiedCount}`,
    );

    // --- Post: rename type value 'repost' -> 'boost' ---
    const postType = await posts.updateMany({ type: 'repost' }, { $set: { type: 'boost' } });
    logger.info(
      `[migration] posts type repost->boost matched=${postType.matchedCount} modified=${postType.modifiedCount}`,
    );

    // --- Post: drop stale repostOf indexes (boostOf indexes are recreated by the schema on boot) ---
    const droppedIndexes = await dropStaleRepostIndexes(posts);
    logger.info(`[migration] posts dropped ${droppedIndexes} stale repostOf index(es)`);

    // --- UserSettings: notificationPreferences.reposts -> .boosts ---
    const settingsRename = await userSettings.updateMany(
      { 'notificationPreferences.reposts': { $exists: true } },
      { $rename: { 'notificationPreferences.reposts': 'notificationPreferences.boosts' } },
    );
    logger.info(
      `[migration] usersettings rename matched=${settingsRename.matchedCount} modified=${settingsRename.modifiedCount}`,
    );

    // --- Analytics: stats.engagement.reposts -> .boosts ---
    const analyticsRename = await analytics.updateMany(
      { 'stats.engagement.reposts': { $exists: true } },
      { $rename: { 'stats.engagement.reposts': 'stats.engagement.boosts' } },
    );
    logger.info(
      `[migration] analytics rename matched=${analyticsRename.matchedCount} modified=${analyticsRename.modifiedCount}`,
    );

    // --- UserBehavior: preferredAuthors[].interactionTypes.reposts -> .boosts ---
    // $rename cannot target array element subfields, so rewrite each array element.
    const behaviorRename = await userBehaviors.updateMany(
      { 'preferredAuthors.interactionTypes.reposts': { $exists: true } },
      [
        {
          $set: {
            preferredAuthors: {
              $map: {
                input: '$preferredAuthors',
                as: 'author',
                in: {
                  $mergeObjects: [
                    '$$author',
                    {
                      interactionTypes: {
                        $mergeObjects: [
                          '$$author.interactionTypes',
                          { boosts: { $ifNull: ['$$author.interactionTypes.reposts', 0] } },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        },
        { $unset: 'preferredAuthors.interactionTypes.reposts' },
      ],
    );
    logger.info(
      `[migration] userbehaviors rename matched=${behaviorRename.matchedCount} modified=${behaviorRename.modifiedCount}`,
    );

    // --- Notification: type 'repost' -> 'boost' ---
    const notificationType = await notifications.updateMany(
      { type: 'repost' },
      { $set: { type: 'boost' } },
    );
    logger.info(
      `[migration] notifications type repost->boost matched=${notificationType.matchedCount} modified=${notificationType.modifiedCount}`,
    );
  },
};
