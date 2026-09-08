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
import { connectPostgres, getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { postMedia } from '../db/schema/postContent';
import { findPostRecords } from '../db/posts/postRepository';
import { mediaMetadataService, isOxyFileId } from '../services/MediaMetadataService';
import { logger } from '../utils/logger';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';

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
      return item.width === undefined || item.height === undefined
        || (item.type === 'video' && item.durationSec === undefined);
    }
    return item.type === 'video'
      && (item.orientation === undefined || item.durationSec === undefined);
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
async function enrichWithRetry(media: MediaItem[]): Promise<MediaItem[]> {
  // Nothing to ask Oxy about — every item is a remote URL the cache never
  // mirrored. `enrichFromOxy` returns the SAME array in that case, which is
  // also how it reports a failed lookup, so without this check a page of purely
  // federated media would be retried four times and then counted `unresolved`.
  // The two cases are told apart here rather than by the identity test below,
  // because only one of them had a question to fail at.
  if (!media.some((item) => isOxyFileId(item.id))) return media.map((item) => ({ ...item }));

  let enriched = media;
  for (let attempt = 1; attempt <= OXY_LOOKUP_ATTEMPTS; attempt += 1) {
    enriched = await mediaMetadataService.enrichFromOxy(media);
    if (enriched !== media) return enriched;
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

/** One media row's intrinsic fields, addressed by the post and its dense position. */
interface MediaMetadataWrite {
  postId: string;
  position: number;
  item: MediaItem;
}

/**
 * Write the page's intrinsic media fields — and ONLY those.
 *
 * This used to call `replacePostContent`, which is the right write for an EDIT:
 * it deletes and re-inserts the post's whole content graph — variants, media,
 * attachments, sources, mentions — inside one transaction, because a changed
 * body can change any of them. Enrichment changes none of them. It fills in six
 * columns on rows that already exist, in place, with the same media set in the
 * same order.
 *
 * The cost of using the edit write for a repair was measured on the first live
 * run: the sweep read and enriched at 230 posts/sec in dry-run mode and wrote at
 * 8-25/sec, so ~120 ms per post went into rewriting rows whose contents were not
 * changing. On a 63,705-post backlog that is the difference between one pass and
 * several.
 *
 * The correctness argument for the addressing: `insertChildRows` writes
 * `position` from the array index and the read path orders by it, so
 * `content.media[i]` IS the row at `position = i`. One statement per page, a
 * `VALUES` join rather than a statement per row.
 *
 * Every value is cast explicitly. A `VALUES` list with a NULL in the first row
 * of a column has no type to infer, and Postgres rejects it — which is the
 * common case here, since these columns are null precisely because nothing had
 * filled them in.
 */
async function applyMediaMetadata(writes: readonly MediaMetadataWrite[]): Promise<void> {
  if (writes.length === 0) return;

  const values = writes.map(({ postId, position, item }) => sql`(
    ${postId}::text,
    ${position}::integer,
    ${item.width ?? null}::integer,
    ${item.height ?? null}::integer,
    ${item.durationSec ?? null}::double precision,
    ${item.orientation ?? null}::text,
    ${item.aspectRatio ?? null}::double precision,
    ${item.sizeBytes ?? null}::integer
  )`);

  await getDb().execute(sql`
    update ${postMedia} set
      width = v.width,
      height = v.height,
      duration_sec = v.duration_sec,
      orientation = v.orientation,
      aspect_ratio = v.aspect_ratio,
      size_bytes = v.size_bytes
    from (values ${sql.join(values, sql`, `)})
      as v(post_id, position, width, height, duration_sec, orientation, aspect_ratio, size_bytes)
    where ${postMedia.postId} = v.post_id
      and ${postMedia.position} = v.position
  `);
}

export async function backfillMediaMetadata(
  opts: { batchSize?: number; dryRun?: boolean } = {},
): Promise<BackfillMediaMetadataResult> {
  const pageSize = opts.batchSize ?? DEFAULT_PAGE_SIZE;
  const dryRun = opts.dryRun ?? false;

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
            or (${postMedia.type} = 'video' and ${postMedia.durationSec} is null)
        else ${postMedia.type} = 'video'
          and (${postMedia.orientation} is null or ${postMedia.durationSec} is null)
      end
  )`;

  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let unresolved = 0;
  let lastId: string | null = null;
  /** The page's writes, applied together — see {@link applyMediaMetadata}. */
  const pendingWrites: MediaMetadataWrite[] = [];

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
    const pageCandidates = rows.map((row) => {
      const media = row.content.media;
      return Array.isArray(media) && media.length > 0 && mediaNeedsEnrichment(media)
        ? media
        : null;
    });
    const flatMedia = pageCandidates.flatMap((media) => media ?? []);
    let enrichedFlat = flatMedia;
    let pageResolved = true;
    if (flatMedia.length > 0) {
      enrichedFlat = await enrichWithRetry(flatMedia);
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

      pendingWrites.push(...enriched.map((item, position) => ({ postId: row.id, position, item })));
    }

    if (pendingWrites.length > 0) {
      await applyMediaMetadata(pendingWrites);
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
    logger.info('[backfillMediaMetadata] progress', { dryRun, scanned, updated, skipped, unresolved });

    if (rows.length < pageSize) break;
  }

  return { scanned, updated, skipped, unresolved };
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
