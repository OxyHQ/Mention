/**
 * Migration script to backfill threadId on existing replies.
 *
 * Existing replies have parentPostId set but no threadId. This script:
 * 1. Finds all replies (posts with parentPostId but no threadId)
 * 2. Looks up the parent post
 * 3. Sets threadId = parent.threadId || parent._id
 *
 * Run once after deploying the threadId-on-reply-creation change.
 */

import mongoose from 'mongoose';
import { Post } from '../models/Post';

const BATCH_SIZE = 500;

async function backfillThreadIds() {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
    const dbName = `mention-${process.env.NODE_ENV || 'development'}`;
    await mongoose.connect(mongoUri, { dbName });
    console.log(`Connected to MongoDB (${dbName})`);

    // Count replies missing threadId
    const totalCount = await Post.countDocuments({
      parentPostId: { $ne: null, $exists: true },
      $or: [{ threadId: null }, { threadId: { $exists: false } }],
    });

    console.log(`Found ${totalCount} replies missing threadId`);

    if (totalCount === 0) {
      console.log('Nothing to do');
      await mongoose.disconnect();
      return;
    }

    let processed = 0;
    let updated = 0;
    let skipped = 0;

    // Process in batches using cursor to avoid loading all into memory
    while (processed < totalCount) {
      const replies = await Post.find({
        parentPostId: { $ne: null, $exists: true },
        $or: [{ threadId: null }, { threadId: { $exists: false } }],
      })
        .select('_id parentPostId')
        .limit(BATCH_SIZE)
        .lean();

      if (replies.length === 0) break;

      // Collect unique parent IDs for batch lookup
      const parentIds = [...new Set(
        replies
          .map(r => String(r.parentPostId))
          .filter(id => mongoose.Types.ObjectId.isValid(id))
      )];

      // Batch fetch parent posts
      const parents = await Post.find({
        _id: { $in: parentIds.map(id => new mongoose.Types.ObjectId(id)) },
      })
        .select('_id threadId')
        .lean();

      const parentMap = new Map<string, { _id: mongoose.Types.ObjectId; threadId?: string }>();
      for (const parent of parents) {
        parentMap.set(parent._id.toString(), parent);
      }

      // Build bulk operations
      const bulkOps: mongoose.AnyBulkWriteOperation<typeof Post>[] = [];
      for (const reply of replies) {
        const parentId = String(reply.parentPostId);
        const parent = parentMap.get(parentId);

        if (!parent) {
          // Parent not found (deleted?), use parentPostId as threadId
          bulkOps.push({
            updateOne: {
              filter: { _id: reply._id },
              update: { $set: { threadId: parentId } },
            },
          });
          skipped++;
        } else {
          const threadId = parent.threadId || parent._id.toString();
          bulkOps.push({
            updateOne: {
              filter: { _id: reply._id },
              update: { $set: { threadId } },
            },
          });
        }
      }

      if (bulkOps.length > 0) {
        const result = await Post.bulkWrite(bulkOps, { ordered: false });
        updated += result.modifiedCount;
      }

      processed += replies.length;
      console.log(`Progress: ${processed}/${totalCount} (updated: ${updated}, parent-missing: ${skipped})`);
    }

    console.log(`Done. Updated ${updated} replies, ${skipped} had missing parents.`);
    await mongoose.disconnect();
  } catch (error) {
    console.error('Migration failed:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

backfillThreadIds();
