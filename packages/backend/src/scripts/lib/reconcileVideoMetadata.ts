import type { MediaItem } from '@mention/shared-types';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb, getPostgresClient } from '../../db/postgres';
import { postContentVariants, postMedia, postVariantMedia } from '../../db/schema/postContent';
import {
  isOxyFileId,
  isRejectedHlsGeneration,
  mediaMetadataChanged,
  mediaMetadataService,
  mergeMediaItem,
  readPersistedMediaFields,
} from '../../services/MediaMetadataService';
import { invalidate as invalidatePostDetailCache } from '../../services/postDetailCache';
import { logger } from '../../utils/logger';
import {
  applyFileMediaMetadata,
  type FileMediaMetadataWrite,
} from '../../services/mediaMetadataPersistence';

const FILE_BATCH_SIZE = 100;
const WRITE_BATCH_SIZE = 500;

export interface VideoReconciliationOptions {
  dryRun?: boolean;
  limitFiles?: number;
  afterFileId?: string;
  passes?: number;
  passDelaySeconds?: number;
}

export interface VideoReconciliationPass {
  pass: number;
  scanned: number;
  updated: number;
  unchanged: number;
  unresolved: number;
  /** Authoritative audio assets carried by the federated video fallback. */
  excludedAudio: number;
  rowsUpdated: number;
  postsUpdated: number;
  /** End of the current scan, which is not evidence that Oxy has finished encoding. */
  reachedEnd: boolean;
  scannedThroughFileId: string | null;
  /** Never advances past an unresolved file. Null resumes from the beginning. */
  resumeAfterFileId: string | null;
}

function boundedInteger(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function readVideoReconciliationOptions(values: {
  'limit-files'?: string;
  'after-file-id'?: string;
  passes?: string;
  'pass-delay-seconds'?: string;
}): VideoReconciliationOptions {
  return {
    limitFiles: values['limit-files'] === undefined ? undefined : Number(values['limit-files']),
    afterFileId: values['after-file-id'],
    passes: values.passes === undefined ? undefined : Number(values.passes),
    passDelaySeconds:
      values['pass-delay-seconds'] === undefined ? undefined : Number(values['pass-delay-seconds']),
  };
}

/** Both indexed arms are bounded before the union; duplicate references consume one lookup. */
async function nextFiles(afterFileId: string | undefined, limit: number): Promise<string[]> {
  const rows = await getDb().execute<{ media_id: string }>(sql`
    select media_id from (
      (select distinct ${postMedia.mediaId} as media_id from ${postMedia}
        where ${postMedia.type} = 'video'
          and btrim(${postMedia.mediaId}) <> '' and ${postMedia.mediaId} !~* '^https?://'
          and ${afterFileId ? sql`${postMedia.mediaId} > ${afterFileId}` : sql`true`}
        order by media_id limit ${limit})
      union
      (select distinct ${postVariantMedia.mediaId} as media_id from ${postVariantMedia}
        where ${postVariantMedia.type} = 'video'
          and btrim(${postVariantMedia.mediaId}) <> '' and ${postVariantMedia.mediaId} !~* '^https?://'
          and ${afterFileId ? sql`${postVariantMedia.mediaId} > ${afterFileId}` : sql`true`}
        order by media_id limit ${limit})
    ) referenced_files order by media_id limit ${limit}
  `);
  return rows.map((row) => row.media_id);
}

async function refreshBatch(fileIds: string[], dryRun: boolean) {
  const db = getDb();
  // Capture row AND file identities before asking Oxy: an edit during that
  // request must not let a repair overwrite a replacement row or another file.
  const [shared, variants] = await Promise.all([
    db
      .select({ media: postMedia, postId: postMedia.postId })
      .from(postMedia)
      .where(and(inArray(postMedia.mediaId, fileIds), eq(postMedia.type, 'video'))),
    db
      .select({ media: postVariantMedia, postId: postContentVariants.postId })
      .from(postVariantMedia)
      .innerJoin(postContentVariants, eq(postContentVariants.id, postVariantMedia.variantId))
      .where(and(inArray(postVariantMedia.mediaId, fileIds), eq(postVariantMedia.type, 'video'))),
  ]);
  let resolved: Awaited<ReturnType<typeof mediaMetadataService.resolveOxyAssets>>;
  try {
    resolved = await mediaMetadataService.resolveOxyAssets(fileIds);
  } catch (error) {
    logger.warn('[reconcileVideoMetadata] source lookup failed', {
      count: fileIds.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      updatedFiles: new Set<string>(),
      postIds: new Set<string>(),
      rowsUpdated: 0,
      unresolved: new Set(fileIds),
      excludedAudio: new Set<string>(),
    };
  }
  const metadata = new Map<string, Partial<MediaItem> & { hlsReadyAt: string }>();
  const rejectedHls = new Map<string, string>();
  const unresolved = new Set<string>();
  const excludedAudio = new Set<string>();
  for (const fileId of fileIds) {
    const asset = resolved.get(fileId);
    // Federated Audio attachments intentionally use Mention's video fallback.
    // Only the authoritative asset MIME can exclude them from video repair.
    const mime = asset?.mime?.split(';', 1)[0]?.trim();
    if (mime && /^audio\/[^\s/;]+$/i.test(mime)) {
      excludedAudio.add(fileId);
      continue;
    }
    if (asset?.hlsRejectedReadyAt) {
      rejectedHls.set(fileId, asset.hlsRejectedReadyAt);
      continue;
    }
    const fields = asset ? readPersistedMediaFields({ ...asset, sizeBytes: asset.size }) : {};
    if (
      !fields.width ||
      !fields.height ||
      !fields.durationSec ||
      !fields.orientation ||
      !fields.aspectRatio ||
      !fields.hlsReadyAt
    ) {
      unresolved.add(fileId);
    } else {
      metadata.set(fileId, { ...fields, hlsReadyAt: fields.hlsReadyAt });
    }
  }
  const writesFor = (
    rows: readonly ((typeof shared)[number] | (typeof variants)[number])[],
  ): FileMediaMetadataWrite[] =>
    rows.flatMap(({ media, postId }) => {
      const fields = metadata.get(media.mediaId);
      const rejectedHlsReadyAt = rejectedHls.get(media.mediaId);
      if (!fields && !rejectedHlsReadyAt) return [];
      const previous: MediaItem = {
        id: media.mediaId,
        type: 'video',
        ...readPersistedMediaFields({ ...media, hlsReadyAt: media.hlsReadyAt?.toISOString() }),
      };
      const previousHlsReadyAt = previous.hlsReadyAt ?? null;
      if (rejectedHlsReadyAt) {
        return isRejectedHlsGeneration(previous.hlsReadyAt, rejectedHlsReadyAt)
          ? [{ rowId: media.id, postId, item: previous, previousHlsReadyAt, rejectedHlsReadyAt }]
          : [];
      }
      if (!fields) return [];
      // A stale source response must not roll a later readiness stamp backwards.
      if (previous.hlsReadyAt && Date.parse(fields.hlsReadyAt) < Date.parse(previous.hlsReadyAt)) {
        unresolved.add(media.mediaId);
        return [];
      }
      const item = mergeMediaItem(previous, fields);
      return mediaMetadataChanged([previous], [item])
        ? [{ rowId: media.id, postId, item, previousHlsReadyAt }]
        : [];
    });
  const sharedCandidates = writesFor(shared);
  const variantCandidates = writesFor(variants);
  const sharedWrites = sharedCandidates.filter((write) => !unresolved.has(write.item.id));
  const variantWrites = variantCandidates.filter((write) => !unresolved.has(write.item.id));
  const changed = dryRun
    ? [...sharedWrites, ...variantWrites]
    : await db.transaction(async (tx) => {
        const applied: FileMediaMetadataWrite[] = [];
        for (const [table, writes] of [
          [postMedia, sharedWrites],
          [postVariantMedia, variantWrites],
        ] as const) {
          for (let offset = 0; offset < writes.length; offset += WRITE_BATCH_SIZE) {
            const batch = writes.slice(offset, offset + WRITE_BATCH_SIZE);
            const ids = await applyFileMediaMetadata(table, batch, tx);
            applied.push(...batch.filter((write) => ids.has(write.rowId)));
          }
        }
        return applied;
      });
  const postIds = new Set(changed.map((write) => write.postId));
  // Publish cache invalidations only after the database transaction committed.
  if (!dryRun) for (const postId of postIds) await invalidatePostDetailCache(postId);
  return {
    updatedFiles: new Set(changed.map((write) => write.item.id)),
    postIds,
    rowsUpdated: changed.length,
    unresolved,
    excludedAudio,
  };
}

/**
 * Reconcile complete video metadata as well as missing fields. A bounded pass
 * may finish before Oxy's asynchronous repair does: requested passes always run,
 * and operators must run a final pass after Oxy's repair inventory settles.
 * Checkpoints are emitted after committed batches to the workflow's durable log.
 */
async function runVideoMetadataReconciliation(
  options: VideoReconciliationOptions = {},
): Promise<{ passes: VideoReconciliationPass[] }> {
  const limitFiles = boundedInteger('--limit-files', options.limitFiles ?? 1000, 1, 1_000_000);
  const passes = boundedInteger('--passes', options.passes ?? 1, 1, 10);
  const delaySeconds = boundedInteger(
    '--pass-delay-seconds',
    options.passDelaySeconds ?? 60,
    0,
    600,
  );
  if (
    options.afterFileId !== undefined &&
    (!isOxyFileId(options.afterFileId) || options.afterFileId !== options.afterFileId.trim())
  ) {
    throw new Error('--after-file-id must name an Oxy file');
  }
  const reports: VideoReconciliationPass[] = [];
  for (let pass = 1; pass <= passes; pass += 1) {
    let cursor = pass === 1 ? options.afterFileId : undefined;
    let retryCursor: string | undefined;
    let retryRequired = false;
    const changedPosts = new Set<string>();
    const report: VideoReconciliationPass = {
      pass,
      scanned: 0,
      updated: 0,
      unchanged: 0,
      unresolved: 0,
      excludedAudio: 0,
      rowsUpdated: 0,
      postsUpdated: 0,
      reachedEnd: false,
      scannedThroughFileId: cursor ?? null,
      resumeAfterFileId: cursor ?? null,
    };
    while (report.scanned < limitFiles) {
      const take = Math.min(FILE_BATCH_SIZE, limitFiles - report.scanned);
      const page = await nextFiles(cursor, take + 1);
      const fileIds = page.slice(0, take);
      if (!fileIds.length) {
        report.reachedEnd = true;
        break;
      }
      const result = await refreshBatch(fileIds, options.dryRun ?? false);
      const firstUnresolved = fileIds.findIndex((id) => result.unresolved.has(id));
      if (!retryRequired && firstUnresolved >= 0) {
        retryRequired = true;
        retryCursor = firstUnresolved === 0 ? cursor : fileIds[firstUnresolved - 1];
      }
      cursor = fileIds[fileIds.length - 1];
      report.scanned += fileIds.length;
      report.updated += result.updatedFiles.size;
      report.unresolved += result.unresolved.size;
      report.excludedAudio += result.excludedAudio.size;
      report.unchanged += fileIds.filter(
        (id) =>
          !result.updatedFiles.has(id) &&
          !result.unresolved.has(id) &&
          !result.excludedAudio.has(id),
      ).length;
      report.rowsUpdated += result.rowsUpdated;
      for (const postId of result.postIds) changedPosts.add(postId);
      report.postsUpdated = changedPosts.size;
      report.reachedEnd = page.length <= take;
      report.scannedThroughFileId = cursor;
      report.resumeAfterFileId = retryRequired
        ? (retryCursor ?? null)
        : report.reachedEnd
          ? null
          : cursor;
      logger.info('[reconcileVideoMetadata] checkpoint', {
        dryRun: options.dryRun ?? false,
        ...report,
      });
      if (report.reachedEnd) break;
    }
    reports.push(report);
    logger.info('[reconcileVideoMetadata] pass finished', {
      ...report,
      upstreamRepairCompletion: 'not inferred from a metadata scan',
    });
    if (!report.reachedEnd) break;
    if (pass < passes && delaySeconds > 0)
      await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
  }
  return { passes: reports };
}

/** A reserved session keeps manual and scheduled runs mutually exclusive. */
export async function reconcileVideoMetadata(
  options: VideoReconciliationOptions = {},
): Promise<{ passes: VideoReconciliationPass[]; alreadyRunning: boolean }> {
  const connection = await getPostgresClient().reserve();
  let locked = false;
  try {
    const [result] = await connection<{ locked: boolean }[]>`
      select pg_try_advisory_lock(hashtext('mention'), hashtext('video-metadata-reconciliation')) as locked
    `;
    locked = result.locked;
    if (!locked) {
      logger.info('[reconcileVideoMetadata] skipped: another reconciliation owns the lock');
      return { passes: [], alreadyRunning: true };
    }
    return { ...(await runVideoMetadataReconciliation(options)), alreadyRunning: false };
  } finally {
    try {
      if (locked) {
        await connection`
          select pg_advisory_unlock(hashtext('mention'), hashtext('video-metadata-reconciliation'))
        `;
      }
    } finally {
      connection.release();
    }
  }
}
