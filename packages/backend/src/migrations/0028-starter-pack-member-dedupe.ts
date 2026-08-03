/**
 * Migration 0028: remove duplicate members from existing starter packs.
 *
 * Membership is a SET, but only one of the three write paths enforced it:
 * `POST /:id/members` unioned into a `Set` while `POST /` and `PUT /:id` stored
 * whatever array the client sent. A pack edited through the wrong endpoint kept
 * the repeat, rendered a row per entry, and counted them — `6a35840f2160a431714b96d5`
 * reached production with seven entries for five accounts. The write side is now
 * a setter on the schema path, so this migration only has to repair what already
 * landed.
 *
 * ORDER IS PRESERVED, WHICH IS WHY THIS DOES NOT USE `$setUnion`. Migration 0002
 * dedupes hashtags with `$setUnion` and notes that its sort is harmless there,
 * because `$in` matching does not care about order. It is NOT harmless here: a
 * pack renders in stored order and the owner arranged it, so sorting would
 * silently reshuffle every pack in the database while claiming to remove
 * duplicates. `$reduce` keeps the first occurrence of each id exactly where it
 * was and drops the later ones.
 *
 * Idempotent: an already-clean array reduces to itself, so the value is
 * unchanged and `modifiedCount` is 0 on a re-run.
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { MIGRATION_STARTER_PACK_MEMBER_DEDUPE } from './constants';
import type { Migration } from './runner';

export const migrationStarterPackMemberDedupe: Migration = {
  id: MIGRATION_STARTER_PACK_MEMBER_DEDUPE,

  async run(db: mongoose.mongo.Db): Promise<void> {
    const packs = db.collection('starterpacks');

    const result = await packs.updateMany(
      { memberOxyUserIds: { $exists: true, $not: { $size: 0 }, $type: 'array' } },
      [
        {
          $set: {
            memberOxyUserIds: {
              $reduce: {
                input: '$memberOxyUserIds',
                initialValue: [],
                in: {
                  $cond: [
                    { $in: ['$$this', '$$value'] },
                    '$$value',
                    { $concatArrays: ['$$value', ['$$this']] },
                  ],
                },
              },
            },
          },
        },
      ],
    );

    logger.info('[Migration] starter pack member dedupe complete', {
      matched: result.matchedCount,
      modified: result.modifiedCount,
    });
  },
};
