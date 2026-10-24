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
import { parseArgs } from 'node:util';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { postContentVariants, postMedia, postVariantMedia } from '../db/schema/postContent';
import { findPostRecords } from '../db/posts/postRepository';
import {
  mediaMetadataChanged,
  mediaMetadataService,
  isOxyFileId,
  isRejectedHlsGeneration,
  mergeMediaItem,
  readPersistedMediaFields,
  type MediaMetadataEnrichment,
} from '../services/MediaMetadataService';
import { invalidate as invalidatePostDetailCache } from '../services/postDetailCache';
import { logger } from '../utils/logger';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import {
  applyFileMediaMetadata,
  type FileMediaMetadataWrite,
} from '../services/mediaMetadataPersistence';
import {
  reconcileVideoMetadata,
  readVideoReconciliationOptions,
} from './lib/reconcileVideoMetadata';

const DEFAULT_PAGE_SIZE = 200;

/** Exit code for "finished, but some posts could not be resolved". Mirrors `backfillFederatedPostAuthors`. */
const EXIT_INCOMPLETE = 75;

export interface BackfillMediaMetadataResult {
  scanned: number;
  updated: number;
  skipped: number;
  /**
   * Posts left un-repaired because Oxy could not answer for their assets — a
   * 429, a timeout, a 5xx. NOT the same as `skipped`, which means "nothing to
   * do": these still need the work, and the run says so rather than reporting a
   * clean sweep over a set it silently failed to resolve.
   */
  unresolved: number;
}

function mediaNeedsEnrichment(items: MediaItem[]): boolean {
  return items.some((item) => {
    if (isOxyFileId(item.id)) {
      return (
        item.width === undefined ||
        item.height === undefined ||
        (item.type === 'video' && (item.durationSec === undefined || item.hlsReadyAt === undefined))
      );
    }
    return (
      item.type === 'video' && (item.orientation === undefined || item.durationSec === undefined)
    );
  });
}

/** Attempts for one page's Oxy lookup, and the base of the exponential wait. */
const OXY_LOOKUP_ATTEMPTS = 4;
const OXY_LOOKUP_BACKOFF_MS = 2_000;

/**
 * One page's Oxy lookup, retried on failure with an exponential wait.
 *
 * Oxy rate-limits its service endpoints, and a sweep is exactly the traffic
 * shape that trips it: a long run of back-to-back batch requests from one
 * caller. A 429 is not a verdict about those assets, it is "ask again later" —
 * and `enrichFromOxy` cannot tell the caller which it was, it just returns the
 * items unchanged. Retrying here is what keeps a throttled page from being
 * silently recorded as a page with nothing to do.
 *
 * Bounded, and it gives up rather than blocking the sweep: the caller counts
 * those posts as `unresolved`, the run reports them, and a re-run picks them up
 * because they never left the candidate set.
 */
async function enrichWithRetry(media: MediaItem[]): Promise<MediaMetadataEnrichment> {
  // Nothing to ask Oxy about — every item is a remote URL the cache never
  // mirrored. `enrichFromOxy` returns the SAME array in that case, which is
  // also how it reports a failed lookup, so without this check a page of purely
  // federated media would be retried four times and then counted `unresolved`.
  // The two cases are told apart here rather than by the identity test below,
  // because only one of them had a question to fail at.
  if (!media.some((item) => isOxyFileId(item.id)))
    return { items: media.map((item) => ({ ...item })), rejectedHls: new Map() };

  let enriched: MediaMetadataEnrichment = { items: media, rejectedHls: new Map() };
  for (let attempt = 1; attempt <= OXY_LOOKUP_ATTEMPTS; attempt += 1) {
    enriched = await mediaMetadataService.enrichFromOxyWithRejections(media);
    if (enriched.items !== media) return enriched;
    if (attempt === OXY_LOOKUP_ATTEMPTS) break;
    const wait = OXY_LOOKUP_BACKOFF_MS * 2 ** (attempt - 1);
    logger.warn('[backfillMediaMetadata] Oxy lookup failed; retrying', {
      attempt,
      of: OXY_LOOKUP_ATTEMPTS,
      waitMs: wait,
      ids: media.length,
    });
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  return enriched;
}

/** Refresh valid but stale metadata after Oxy replaces a video's encoding profile. */
async function refreshFileMediaMetadata(
  fileId: string,
  pageSize: number,
  dryRun: boolean,
): Promise<BackfillMediaMetadataResult> {
  const db = getDb();
  const result: BackfillMediaMetadataResult = { scanned: 0, updated: 0, skipped: 0, unresolved: 0 };
  let lastId: string | undefined;
  for (;;) {
    // Both arms start at the media_id index; a targeted repair never scans or
    // hydrates every post to find the few references to one file.
    const page = await db.execute<{ id: string }>(sql`
      select id from (
        select ${postMedia.postId} as id from ${postMedia}
          where ${postMedia.mediaId} = ${fileId} and ${postMedia.type} = 'video'
        union
        select ${postContentVariants.postId} as id from ${postVariantMedia}
          join ${postContentVariants} on ${postContentVariants.id} = ${postVariantMedia.variantId}
          where ${postVariantMedia.mediaId} = ${fileId} and ${postVariantMedia.type} = 'video'
      ) references_file
      where ${lastId ? sql`id > ${lastId}` : sql`true`}
      order by id limit ${pageSize}
    `);
    if (page.length === 0) break;
    const postIds = page.map((row) => row.id);
    lastId = postIds[postIds.length - 1];
    result.scanned += page.length;
    const [sharedRows, variantRows] = await Promise.all([
      db
        .select({ media: postMedia, postId: postMedia.postId })
        .from(postMedia)
        .where(
          and(
            inArray(postMedia.postId, postIds),
            eq(postMedia.mediaId, fileId),
            eq(postMedia.type, 'video'),
          ),
        ),
      db
        .select({ media: postVariantMedia, postId: postContentVariants.postId })
        .from(postVariantMedia)
        .innerJoin(postContentVariants, eq(postContentVariants.id, postVariantMedia.variantId))
        .where(
          and(
            inArray(postContentVariants.postId, postIds),
            eq(postVariantMedia.mediaId, fileId),
            eq(postVariantMedia.type, 'video'),
          ),
        ),
    ]);
    const rows = [...sharedRows, ...variantRows];
    const current: MediaItem[] = rows.map(({ media }) => ({
      id: media.mediaId,
      type: 'video',
      ...readPersistedMediaFields({ ...media, hlsReadyAt: media.hlsReadyAt?.toISOString() }),
    }));
    const lookup: MediaItem[] = [{ id: fileId, type: 'video' }];
    const resolution = await enrichWithRetry(lookup);
    const [resolved] = resolution.items;
    const rejectedHlsReadyAt = resolution.rejectedHls.get(fileId);
    const metadata = resolved ? readPersistedMediaFields({ ...resolved }) : {};
    // Start the lookup without old values, so a missing or not-yet-repaired
    // asset cannot borrow its old dimensions or ladder stamp and look complete.
    if (
      !rejectedHlsReadyAt &&
      (!metadata.width ||
        !metadata.height ||
        !metadata.durationSec ||
        !metadata.orientation ||
        !metadata.aspectRatio ||
        !metadata.hlsReadyAt)
    ) {
      result.unresolved += page.length;
    } else {
      const sharedWrites: FileMediaMetadataWrite[] = [];
      const variantWrites: FileMediaMetadataWrite[] = [];
      rows.forEach((row, index) => {
        const previous = current[index];
        if (!previous) return;
        const item = mergeMediaItem(previous, metadata);
        if (rejectedHlsReadyAt) {
          if (!isRejectedHlsGeneration(previous.hlsReadyAt, rejectedHlsReadyAt)) return;
          delete item.hlsReadyAt;
        }
        if (!mediaMetadataChanged([previous], [item])) return;
        const writes = index < sharedRows.length ? sharedWrites : variantWrites;
        writes.push({
          rowId: row.media.id,
          postId: row.postId,
          item,
          previousHlsReadyAt: previous.hlsReadyAt ?? null,
          rejectedHlsReadyAt,
        });
      });
      const writes = [...sharedWrites, ...variantWrites];
      let changed = writes;
      if (!dryRun) {
        changed = await db.transaction(async (tx) => {
          const sharedUpdated = await applyFileMediaMetadata(postMedia, sharedWrites, tx);
          const variantUpdated = await applyFileMediaMetadata(postVariantMedia, variantWrites, tx);
          return [
            ...sharedWrites.filter((write) => sharedUpdated.has(write.rowId)),
            ...variantWrites.filter((write) => variantUpdated.has(write.rowId)),
          ];
        });
      }
      const changedPosts = new Set(changed.map((write) => write.postId));
      if (!dryRun) for (const postId of changedPosts) await invalidatePostDetailCache(postId);
      const updated = changedPosts.size;
      result.updated += updated;
      result.skipped += page.length - updated;
    }
    logger.info('[backfillMediaMetadata] progress', { dryRun, fileId, ...result });
    if (page.length < pageSize) break;
  }
  return result;
}

export async function backfillMediaMetadata(
  opts: { batchSize?: number; dryRun?: boolean; fileId?: string } = {},
): Promise<BackfillMediaMetadataResult> {
  const pageSize = opts.batchSize ?? DEFAULT_PAGE_SIZE;
  const dryRun = opts.dryRun ?? false;
  if (opts.fileId !== undefined) {
    if (!isOxyFileId(opts.fileId) || opts.fileId !== opts.fileId.trim()) {
      throw new Error('--file-id must name one Oxy file, not a remote URL');
    }
    return refreshFileMediaMetadata(opts.fileId, pageSize, dryRun);
  }

  // "Has at least one media row that still NEEDS enriching", as an EXISTS over
  // the child table. It replaces a plain "has any media row" probe, and the
  // difference is not an optimization — it is what makes the sweep finishable.
  //
  // The old filter hydrated the full content graph of EVERY post carrying media
  // and then discarded most of them in {@link mediaNeedsEnrichment}. With the
  // whole corpus in that set and no persisted cursor, a run stopped by its
  // container timeout restarts from `posts.id` order at the top and re-hydrates
  // the same already-enriched prefix, so the backlog at the far end is never
  // reached. Filtering here means a repaired post LEAVES the candidate set, and
  // a re-run resumes over what is left.
  //
  // The predicate mirrors {@link mediaNeedsEnrichment} exactly, arm for arm,
  // with the same discriminator: an id that is not an `http(s)` URL is an Oxy
  // file id we can ask Oxy about, anything else is a remote URL we cannot.
  // `mediaNeedsEnrichment` remains the authority — this only narrows what is
  // hydrated — but a NARROWER predicate here would silently skip rows the
  // authority would have repaired, so `backfillMediaMetadata.test.ts` seeds one
  // post per arm and asserts the two agree.
  const baseFilter = sql`exists (
    select 1 from ${postMedia}
    where ${postMedia.postId} = ${posts.id}
      and case
        when ${postMedia.mediaId} !~* '^https?://'
          then ${postMedia.width} is null
            or ${postMedia.height} is null
            or (${postMedia.type} = 'video'
              and (${postMedia.durationSec} is null or ${postMedia.hlsReadyAt} is null))
        else ${postMedia.type} = 'video'
          and (${postMedia.orientation} is null or ${postMedia.durationSec} is null)
      end
  )`;

  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let unresolved = 0;
  let lastId: string | null = null;
  /** The page's identity-guarded intrinsic writes, applied together. */
  const pendingWrites: FileMediaMetadataWrite[] = [];

  for (;;) {
    const rows = await findPostRecords(
      lastId ? and(baseFilter, gt(posts.id, lastId)) : baseFilter,
      { orderBy: [asc(posts.id)], limit: pageSize },
    );

    if (rows.length === 0) break;

    /**
     * ONE Oxy lookup per page, not per post.
     *
     * `enrichFromOxy` was called inside the row loop, so a page of 200 posts
     * was 200 round trips to `/assets/service/by-ids` carrying one to four ids
     * each — and Oxy rate-limits its service endpoints. Measured on the first
     * production run: a wall of `status 429`, each one leaving that post
     * un-enriched while the sweep counted it as "nothing to do". The SDK
     * already chunks at 100 ids per request, so handing it the whole page's
     * media turns those 200 requests into a handful.
     *
     * The concatenation is order-preserving and `enrichFromOxy` returns one
     * item per input item, so each post's slice comes back at the same offset.
     * That is the contract this relies on, and `mediaMetadataService.test.ts`
     * pins it.
     */
    const mediaRows = await getDb()
      .select()
      .from(postMedia)
      .where(
        inArray(
          postMedia.postId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(postMedia.position);
    const mediaByPost = new Map<string, typeof mediaRows>();
    for (const media of mediaRows) {
      const group = mediaByPost.get(media.postId) ?? [];
      group.push(media);
      mediaByPost.set(media.postId, group);
    }
    const pageCandidates = rows.map((row) => {
      const media = mediaByPost.get(row.id)?.map((entry) => ({
        id: entry.mediaId,
        type: entry.type,
        ...readPersistedMediaFields({ ...entry, hlsReadyAt: entry.hlsReadyAt?.toISOString() }),
      }));
      return Array.isArray(media) && media.length > 0 && mediaNeedsEnrichment(media) ? media : null;
    });
    const flatMedia = pageCandidates.flatMap((media) => media ?? []);
    let enrichedFlat = flatMedia;
    let rejectedHls: ReadonlyMap<string, string> = new Map();
    let pageResolved = true;
    if (flatMedia.length > 0) {
      const resolution = await enrichWithRetry(flatMedia);
      enrichedFlat = resolution.items;
      rejectedHls = resolution.rejectedHls;
      // `enrichFromOxy` returns the items UNCHANGED when the lookup failed, and
      // an unchanged item is indistinguishable from "Oxy has nothing to add".
      // Identity is the only signal available, and it is the honest one: it is
      // the same array object only on the failure path.
      pageResolved = enrichedFlat !== flatMedia;
    }

    let offset = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      scanned += 1;
      lastId = row.id;
      const current = pageCandidates[index];
      if (!current) {
        skipped += 1;
        continue;
      }

      const enriched = enrichedFlat.slice(offset, offset + current.length);
      offset += current.length;

      if (!pageResolved) {
        unresolved += 1;
        continue;
      }

      if (!mediaMetadataChanged(current, enriched)) {
        skipped += 1;
        continue;
      }

      if (dryRun) {
        updated += 1;
        continue;
      }

      const captured = mediaByPost.get(row.id) ?? [];
      enriched.forEach((item, index) => {
        const previous = captured[index];
        if (!previous || previous.mediaId !== item.id) return;
        pendingWrites.push({
          rowId: previous.id,
          postId: row.id,
          item,
          previousHlsReadyAt: previous.hlsReadyAt?.toISOString() ?? null,
          rejectedHlsReadyAt: rejectedHls.get(item.id),
        });
      });
    }

    if (pendingWrites.length > 0) {
      const changed = await applyFileMediaMetadata(postMedia, pendingWrites);
      const changedPosts = new Set(
        pendingWrites.filter((write) => changed.has(write.rowId)).map((write) => write.postId),
      );
      updated += changedPosts.size;
      skipped += new Set(pendingWrites.map((write) => write.postId)).size - changedPosts.size;
      for (const postId of changedPosts) await invalidatePostDetailCache(postId);
      pendingWrites.length = 0;
    }

    // A progress line per page, at INFO.
    //
    // The run is bounded by its container's `timeout` (3300s in
    // `run-media-metadata-backfill.yml`) and holds no cursor, so a sweep that
    // outlives the bound is SIGTERMed — and the summary below never runs. On a
    // write run that costs only the total, since the writes are committed and a
    // repaired post leaves the candidate set. On a DRY run it costs everything:
    // the whole point of the preview is the number, and a killed preview
    // reported nothing at all. Per page, the number survives in the log
    // whatever happens to the process.
    logger.info('[backfillMediaMetadata] progress', {
      dryRun,
      scanned,
      updated,
      skipped,
      unresolved,
    });

    if (rows.length < pageSize) break;
  }

  return { scanned, updated, skipped, unresolved };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      'file-id': { type: 'string' },
      'refresh-videos': { type: 'boolean', default: false },
      'limit-files': { type: 'string' },
      'after-file-id': { type: 'string' },
      passes: { type: 'string' },
      'pass-delay-seconds': { type: 'string' },
    },
  });
  const dryRun = values['dry-run'];
  const fileId = values['file-id'];
  const refreshVideos = values['refresh-videos'];
  if (refreshVideos && fileId !== undefined) {
    throw new Error('--refresh-videos and --file-id are mutually exclusive');
  }
  if (
    !refreshVideos &&
    ['limit-files', 'after-file-id', 'passes', 'pass-delay-seconds'].some(
      (key) => values[key as keyof typeof values] !== undefined,
    )
  ) {
    throw new Error('Reconciliation limits/cursors require --refresh-videos');
  }

  try {
    assertAdminMutationAllowed({
      scriptName: 'backfillMediaMetadata',
      dryRun,
    });
    await connectPostgres();
    if (refreshVideos) {
      const result = await reconcileVideoMetadata({
        dryRun,
        ...readVideoReconciliationOptions(values),
      });
      logger.info('[backfillMediaMetadata] video reconciliation finished', { dryRun, ...result });
      if (result.alreadyRunning) return;
      const last = result.passes[result.passes.length - 1];
      if (!last?.reachedEnd || last.unresolved > 0) process.exitCode = EXIT_INCOMPLETE;
      return;
    }
    const result = await backfillMediaMetadata({ dryRun, fileId });
    logger.info('[backfillMediaMetadata] complete', { dryRun, fileId, ...result });
    // A sweep that could not resolve some posts is INCOMPLETE, not failed:
    // everything it did write is committed, and the posts it missed never left
    // the candidate set, so a re-run picks them up. Saying so with a distinct
    // exit code is what lets the workflow tell "re-run me" apart from "the
    // script threw" — the same split `backfillFederatedPostAuthors` uses.
    if (result.unresolved > 0) process.exitCode = EXIT_INCOMPLETE;
  } finally {
    await closeAdminScriptResources();
  }
}

if (require.main === module) {
  main()
    // `process.exitCode` and not `exit(0)`: `main` sets EXIT_INCOMPLETE when the
    // sweep left posts unresolved, and exiting zero here would erase it.
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((error) => {
      logger.error('[backfillMediaMetadata] failed', error);
      process.exit(1);
    });
}
