import type mongoose from 'mongoose';
import { POST_RECENT_REPLIER_LIMIT } from '../db/schema/postContent';
import {
  POST_RECENT_REPLIER_COLLECTION,
  POST_RECENT_REPLIER_INDEX,
  type RecentReplierEntry,
} from '../models/PostRecentReplier';
import { logger } from '../utils/logger';
import { MIGRATION_POST_RECENT_REPLIERS } from './constants';
import type { Migration } from './runner';

const BULK_SIZE = 500;

interface SourceReply {
  parentPostId: string;
  oxyUserId: string;
  createdAt?: Date;
  status?: string;
  visibility?: string;
}

interface ProjectionDoc {
  postId: string;
  repliers: RecentReplierEntry[];
  createdAt: Date;
  updatedAt: Date;
}

export const migrationPostRecentRepliers: Migration = {
  id: MIGRATION_POST_RECENT_REPLIERS,

  async run(db: mongoose.mongo.Db, context): Promise<void> {
    const posts = db.collection<SourceReply>('posts');
    const projection = db.collection<ProjectionDoc>(POST_RECENT_REPLIER_COLLECTION);

    // A retry after a task death rebuilds from the authoritative Post rows,
    // rather than preserving a partially projected collection.
    await context?.assertLease();
    await projection.deleteMany({});
    await context?.assertLease();
    await projection.createIndex(
      { postId: 1 },
      { unique: true, name: POST_RECENT_REPLIER_INDEX },
    );
    await context?.assertLease();

    const operations: mongoose.mongo.AnyBulkWriteOperation<ProjectionDoc>[] = [];
    let parentCount = 0;
    let currentPostId: string | null = null;
    let currentRepliers: RecentReplierEntry[] = [];
    const currentUserIds = new Set<string>();

    const flushOperations = async (): Promise<void> => {
      if (operations.length === 0) return;
      await context?.assertLease();
      await projection.bulkWrite(operations, { ordered: false });
      operations.length = 0;
    };

    const queueCurrentParent = async (): Promise<void> => {
      if (!currentPostId || currentRepliers.length === 0) return;
      const now = new Date();
      operations.push({
        updateOne: {
          filter: { postId: currentPostId },
          update: {
            $set: {
              postId: currentPostId,
              repliers: currentRepliers,
              updatedAt: now,
            },
            $setOnInsert: { createdAt: now },
          },
          upsert: true,
        },
      });
      parentCount += 1;
      if (operations.length >= BULK_SIZE) {
        await flushOperations();
      }
    };

    // parentPostId is a STRING in Post. Sorting by the existing
    // { parentPostId: 1, createdAt: -1 } index makes each parent contiguous;
    // only three distinct author ids are retained in memory for each parent.
    const cursor = posts
      .find(
        {
          parentPostId: { $type: 'string', $ne: '' },
          oxyUserId: { $type: 'string', $ne: '' },
          $and: [
            { $or: [{ status: 'published' }, { status: { $exists: false } }] },
            { $or: [{ visibility: 'public' }, { visibility: { $exists: false } }] },
          ],
        },
        {
          projection: {
            _id: 0,
            parentPostId: 1,
            oxyUserId: 1,
            createdAt: 1,
          },
        },
      )
      .sort({ parentPostId: 1, createdAt: -1 });

    for await (const reply of cursor) {
      const postId = String(reply.parentPostId ?? '');
      const oxyUserId = String(reply.oxyUserId ?? '');
      if (!postId || !oxyUserId) continue;

      if (currentPostId !== postId) {
        await queueCurrentParent();
        currentPostId = postId;
        currentRepliers = [];
        currentUserIds.clear();
      }

      if (
        currentRepliers.length >= POST_RECENT_REPLIER_LIMIT ||
        currentUserIds.has(oxyUserId)
      ) {
        continue;
      }

      const repliedAt =
        reply.createdAt instanceof Date && Number.isFinite(reply.createdAt.getTime())
          ? reply.createdAt
          : new Date(0);
      currentUserIds.add(oxyUserId);
      currentRepliers.push({ oxyUserId, repliedAt });
    }

    await queueCurrentParent();
    await flushOperations();

    logger.info('[migration] recent replier projection rebuilt', {
      parents: parentCount,
      limitPerParent: POST_RECENT_REPLIER_LIMIT,
    });
  },
};
