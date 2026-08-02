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

import type { MediaItem } from '@mention/shared-types';
import { and, asc, gt, sql } from 'drizzle-orm';
import { connectPostgres } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { postMedia } from '../db/schema/postContent';
import { findPostRecords, replacePostContent } from '../db/posts/postRepository';
import { mediaMetadataService, isOxyFileId } from '../services/MediaMetadataService';
import { logger } from '../utils/logger';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';

const DEFAULT_PAGE_SIZE = 200;

export interface BackfillMediaMetadataResult {
  scanned: number;
  updated: number;
  skipped: number;
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

  // "Has at least one media row", as an EXISTS over the child table — the
  // analogue of Mongo's `content.media.0` existence probe on the embedded array.
  const baseFilter = sql`exists (
    select 1 from ${postMedia} where ${postMedia.postId} = ${posts.id}
  )`;

  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let lastId: string | null = null;

  for (;;) {
    const rows = await findPostRecords(
      lastId ? and(baseFilter, gt(posts.id, lastId)) : baseFilter,
      { orderBy: [asc(posts.id)], limit: pageSize },
    );

    if (rows.length === 0) break;

    for (const row of rows) {
      scanned += 1;
      lastId = row.id;
      const current = row.content.media;
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

      // The whole content graph: `post_media` rows carry a dense `position`, so
      // the transactional delete-then-insert is the only write that keeps the
      // gallery's order intact. `mentions` are re-supplied unchanged.
      await replacePostContent(row.id, { ...row.content, media: enriched }, row.mentions);
    }

    if (rows.length < pageSize) break;
  }

  return { scanned, updated, skipped };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  try {
    assertAdminMutationAllowed({
      scriptName: 'backfillMediaMetadata',
      dryRun,
    });
    await connectPostgres();
    const result = await backfillMediaMetadata({ dryRun });
    logger.info('[backfillMediaMetadata] complete', { dryRun, ...result });
  } finally {
    await closeAdminScriptResources();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[backfillMediaMetadata] failed', error);
      process.exit(1);
    });
}
