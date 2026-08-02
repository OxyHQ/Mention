/**
 * Migration 0023: `post_lane_chrono_v1` on `posts`.
 *
 * The lane tab pages ONE lane chronologically, on the `ChronoCursor` keyset —
 * `{ laneId, visibility, status, createdAt: -1, _id: -1 }` serves it end to end:
 * the lane is reached directly, visibility+status narrow to what may be served,
 * and `createdAt`/`_id` order the page from the index instead of through a
 * blocking sort. The same index serves the per-lane post counts the management
 * screen aggregates, which is why no denormalized counter exists.
 *
 * `partialFilterExpression`, NOT `sparse`. Mongo indexes a document in a SPARSE
 * compound index when ANY indexed key is present, and every post has
 * `visibility`, `status` and `createdAt` — so `sparse` would index the whole
 * collection and save nothing. The partial filter genuinely excludes posts with
 * no lane, which is nearly all of them. Precedent for the partial form:
 * `MTN_RECORD_ID_INDEX` in `indexes/manifest.ts`.
 *
 * The schema declares it, but `autoIndex`/`autoCreate` are OFF in production
 * (see `utils/database.ts`), so this migration is the only thing that creates it
 * — the same relationship `0014-post-trend-terms-index` documents. It is
 * deliberately NOT an entry in `POST_HOT_PATH_INDEXES`: that array is migration
 * 0010's payload, 0010 is already applied, and the runner skips an applied
 * migration — so an entry there would be a silent no-op in production.
 *
 * Idempotent and data-free: `createIndex` with an identical spec is a no-op, and
 * nothing is backfilled — a post written before lanes existed simply carries no
 * `laneId`, which is exactly what the partial filter excludes.
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { MIGRATION_POST_LANE_INDEX } from './constants';
import { Post } from '../models/Post';
import type { Migration } from './runner';

export const migrationPostLaneIndex: Migration = {
  id: MIGRATION_POST_LANE_INDEX,

  async run(db: mongoose.mongo.Db): Promise<void> {
    const posts = db.collection(Post.collection.collectionName);
    await posts.createIndex(
      { laneId: 1, visibility: 1, status: 1, createdAt: -1, _id: -1 },
      { name: 'post_lane_chrono_v1', partialFilterExpression: { laneId: { $exists: true } } },
    );
    logger.info(
      `[migration] ensured index post_lane_chrono_v1 on ${posts.collectionName} ` +
        '{ laneId: 1, visibility: 1, status: 1, createdAt: -1, _id: -1 } ' +
        'partial on { laneId: { $exists: true } }',
    );
  },
};
