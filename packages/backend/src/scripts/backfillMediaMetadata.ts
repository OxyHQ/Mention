/**
 * One-shot backfill: copy Oxy intrinsic media metadata onto post content.media[].
 *
 * Run after Oxy's `backfillFileMediaMetadata` so by-ids returns width/height/
 * durationSec/orientation/aspectRatio. Posts with remote URLs that were cached
 * to Oxy file ids are enriched via the same path; AP pre-cached dims remain
 * until Oxy wins on enrich.
 *
 * Runnable as a Fargate one-shot:
 *   bun packages/backend/dist/src/scripts/backfillMediaMetadata.js
 *   bun packages/backend/dist/src/scripts/backfillMediaMetadata.js --dry-run
 */

import mongoose from 'mongoose';
import type { MediaItem } from '@mention/shared-types';
import { Post } from '../models/Post';
import { mediaMetadataService, isOxyFileId } from '../services/MediaMetadataService';
import { logger } from '../utils/logger';

const DEFAULT_PAGE_SIZE = 200;
const BULK_CHUNK_SIZE = 200;

export interface BackfillMediaMetadataResult {
  scanned: number;
  updated: number;
  skipped: number;
}

interface PostMediaRow {
  _id: mongoose.Types.ObjectId;
  content?: { media?: MediaItem[] };
}

function mediaNeedsEnrichment(items: MediaItem[]): boolean {
  return items.some((item) => {
    if (isOxyFileId(item.id)) {
      return item.width === undefined || item.height === undefined
        || (item.type === 'video' && item.durationSec === undefined);
    }
    return item.type === 'video'
      && (item.orientation === undefined || item.durationSec === undefined);
  });
}

export async function backfillMediaMetadata(
  opts: { batchSize?: number; dryRun?: boolean } = {},
): Promise<BackfillMediaMetadataResult> {
  const pageSize = opts.batchSize ?? DEFAULT_PAGE_SIZE;
  const dryRun = opts.dryRun ?? false;

  const baseFilter: Record<string, unknown> = {
    'content.media.0': { $exists: true },
  };

  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let lastId: mongoose.Types.ObjectId | null = null;
  let pendingOps: mongoose.AnyBulkWriteOperation<typeof Post>[] = [];

  const flush = async (): Promise<void> => {
    if (pendingOps.length === 0 || dryRun) {
      pendingOps = [];
      return;
    }
    await Post.bulkWrite(pendingOps, { ordered: false });
    pendingOps = [];
  };

  for (;;) {
    const pageFilter: Record<string, unknown> = lastId
      ? { ...baseFilter, _id: { $gt: lastId } }
      : baseFilter;

    const rows: PostMediaRow[] = await Post.find(pageFilter)
      .select({ 'content.media': 1 })
      .sort({ _id: 1 })
      .limit(pageSize)
      .lean<PostMediaRow[]>();

    if (rows.length === 0) break;

    for (const row of rows) {
      scanned += 1;
      lastId = row._id;
      const current = row.content?.media;
      if (!Array.isArray(current) || current.length === 0) {
        skipped += 1;
        continue;
      }
      if (!mediaNeedsEnrichment(current)) {
        skipped += 1;
        continue;
      }

      const enriched = await mediaMetadataService.enrichFromOxy(current);
      const changed = enriched.some((item, index) => {
        const prev = current[index];
        return (
          item.width !== prev.width
          || item.height !== prev.height
          || item.durationSec !== prev.durationSec
          || item.orientation !== prev.orientation
          || item.aspectRatio !== prev.aspectRatio
          || item.sizeBytes !== prev.sizeBytes
        );
      });

      if (!changed) {
        skipped += 1;
        continue;
      }

      updated += 1;
      if (dryRun) continue;

      pendingOps.push({
        updateOne: {
          filter: { _id: row._id },
          update: { $set: { 'content.media': enriched } },
        },
      });

      if (pendingOps.length >= BULK_CHUNK_SIZE) {
        await flush();
      }
    }

    if (rows.length < pageSize) break;
  }

  await flush();
  return { scanned, updated, skipped };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) {
    logger.error('[backfillMediaMetadata] MONGODB_URI is required');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  try {
    const result = await backfillMediaMetadata({ dryRun });
    logger.info('[backfillMediaMetadata] complete', { dryRun, ...result });
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

if (require.main === module) {
  void main();
}
