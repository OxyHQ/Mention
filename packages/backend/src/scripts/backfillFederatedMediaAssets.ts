import mongoose, { Types } from 'mongoose';

import { Post } from '../models/Post';
import {
  FEDERATED_MEDIA_BACKFILL_MATCH,
  backfillFederatedMediaPost,
  type FederatedMediaBackfillPost,
} from '../services/mediaCache/federatedMediaBackfill';
import { connectToDatabase, isDatabaseConnected } from '../utils/database';
import { logger } from '../utils/logger';

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_CONCURRENCY = 3;

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildQuery(afterId?: Types.ObjectId): Record<string, unknown> {
  return {
    ...FEDERATED_MEDIA_BACKFILL_MATCH,
    ...(afterId ? { _id: { $gt: afterId } } : {}),
  };
}

async function countRemaining(): Promise<number> {
  return Post.countDocuments(FEDERATED_MEDIA_BACKFILL_MATCH);
}

async function main(): Promise<void> {
  const batchSize = readPositiveInt('FEDERATED_MEDIA_BACKFILL_SCRIPT_BATCH_SIZE', DEFAULT_BATCH_SIZE);
  const concurrency = readPositiveInt('FEDERATED_MEDIA_BACKFILL_SCRIPT_CONCURRENCY', DEFAULT_CONCURRENCY);

  if (process.env.FEDERATION_MEDIA_CACHE_WRITE_ENABLED !== 'true') {
    throw new Error('FEDERATION_MEDIA_CACHE_WRITE_ENABLED must be true for this migration');
  }

  await connectToDatabase();
  if (!isDatabaseConnected()) {
    throw new Error('MongoDB connection was not established');
  }

  const startedRemaining = await countRemaining();
  logger.info('[MediaBackfillScript] starting full federated media migration', {
    startedRemaining,
    batchSize,
    concurrency,
  });

  let afterId: Types.ObjectId | undefined;
  let scannedPosts = 0;
  let updatedPosts = 0;
  let convertedMedia = 0;
  let failedMedia = 0;

  while (true) {
    const posts = await Post.find(buildQuery(afterId))
      .select('_id oxyUserId federation.activityId content.media content.attachments')
      .sort({ _id: 1 })
      .limit(batchSize)
      .lean<FederatedMediaBackfillPost[]>();

    if (posts.length === 0) break;
    afterId = posts[posts.length - 1]._id;
    scannedPosts += posts.length;

    for (let i = 0; i < posts.length; i += concurrency) {
      const batch = posts.slice(i, i + concurrency);
      const settled = await Promise.allSettled(batch.map((post) => backfillFederatedMediaPost(post)));

      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') {
          updatedPosts += outcome.value.updatedPosts;
          convertedMedia += outcome.value.convertedMedia;
          failedMedia += outcome.value.failedMedia;
        } else {
          failedMedia += 1;
          logger.warn('[MediaBackfillScript] post conversion threw', {
            reason: outcome.reason instanceof Error ? outcome.reason.message : 'unknown',
          });
        }
      }
    }

    logger.info('[MediaBackfillScript] progress', {
      scannedPosts,
      updatedPosts,
      convertedMedia,
      failedMedia,
      lastId: String(afterId),
    });
  }

  const remaining = await countRemaining();
  logger.info('[MediaBackfillScript] complete', {
    startedRemaining,
    scannedPosts,
    updatedPosts,
    convertedMedia,
    failedMedia,
    remaining,
  });

  if (remaining > 0) {
    throw new Error(`Federated media migration left ${remaining} posts with remote media ids`);
  }
}

main()
  .catch((error: unknown) => {
    logger.error('[MediaBackfillScript] failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch((error: unknown) => {
      logger.warn('[MediaBackfillScript] failed to disconnect MongoDB', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
    });
  });
