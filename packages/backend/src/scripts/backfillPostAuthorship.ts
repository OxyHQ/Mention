/**
 * One-shot backfill: seed authorship[] from oxyUserId for legacy posts.
 * Idempotent — skips posts that already have authorship.
 */
import mongoose from 'mongoose';
import { Post } from '../models/Post';
import { logger } from '../utils/logger';

async function main(): Promise<void> {
  const mongoUrl = process.env.MONGODB_URI || process.env.MONGO_URL;
  if (!mongoUrl) {
    throw new Error('MONGODB_URI or MONGO_URL required');
  }

  await mongoose.connect(mongoUrl);
  logger.info('Connected — backfilling post authorship');

  const cursor = Post.find({
    $or: [
      { authorship: { $exists: false } },
      { authorship: { $size: 0 } },
    ],
    oxyUserId: { $exists: true, $ne: null },
  }).cursor();

  let updated = 0;
  for await (const post of cursor) {
    if (!post.oxyUserId) continue;
    post.authorship = [{ oxyUserId: post.oxyUserId, role: 'owner', status: 'accepted' }];
    await post.save();
    updated += 1;
    if (updated % 500 === 0) {
      logger.info(`Backfilled ${updated} posts...`);
    }
  }

  logger.info(`Backfill complete — updated ${updated} posts`);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  logger.error('Backfill failed', { error: err });
  mongoose.disconnect().finally(() => process.exit(1));
});
