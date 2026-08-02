import { enrichLinkPreviews } from './linkPreviewStep';
import { enrichMediaMetadata } from './mediaMetadataStep';
import { logger } from '../../utils/logger';
import type { IngestedPost, PostEnrichmentStep } from './types';

export type { IngestedPost, PostEnrichmentStep } from './types';

/**
 * THE post-ingest enrichment step: everything a newly-stored post gets, run
 * once, for every post, whoever stored it.
 *
 * WHY THIS EXISTS. A post reaches the database by two structurally different
 * routes. Native creates and the single-post federated imports (the ActivityPub
 * inbox `Create`, the atproto author-feed import) go through
 * `PostCreationService`. The ActivityPub outbox backfill deliberately does NOT:
 * it assembles whole `PostRecordInput`s and writes them straight through the
 * repository, seeding `postClassification` / `mentions` / `status` by hand so an
 * imported note keeps the remote's own values rather than this service's
 * defaults. That split is intentional and stays.
 *
 * What was NOT intentional is that each enrichment had to be remembered
 * separately on each route. Media metadata was added to the native route and
 * forgotten on the backfill, so federated media stayed permanently dimensionless
 * until an explicit enqueue was added there. Link previews were then missed in
 * the very same way. And scheduled posts turned out to be missing the preview
 * warm on BOTH routes — `create` skipped it while the post was not yet
 * published, and the publish step never had one. Three omissions, one cause: the
 * fan-out lived at the call sites, so every new enrichment was a fresh chance to
 * forget one.
 *
 * So the fan-out lives HERE instead. A creator's whole obligation is to call
 * `enrichIngestedPosts` once with what it just stored; a new enrichment is added
 * to {@link POST_ENRICHMENT_STEPS} alone and every route gets it for free.
 *
 * WHY NOT ONE QUEUE JOB. A single BullMQ "enrich post" job keyed on post id was
 * the obvious alternative and is the wrong shape here. Media metadata already
 * owns a queue whose `attempts` / `backoff` and retry-while-pending semantics
 * are specific to waiting on Oxy's asset probe, so wrapping it would either
 * duplicate that tuning or destroy it; link previews need no durability at all,
 * because Oxy queues its own resolve server-side. And the queues are env-gated
 * on `REDIS_URL` with an inline fallback, so routing every enrichment through
 * one job would make the whole step vanish on a Redis-less deployment. This is
 * therefore an in-process fan-out, and each step keeps whatever transport it
 * actually needs.
 *
 * The parity this buys is pinned by `postEnrichmentParity.test.ts`, which fails
 * if a step is added to this directory without being registered below, or if a
 * creator reaches past this entry point to run an enrichment of its own.
 */

/**
 * Every post-ingest enrichment, in run order. This list is the whole contract:
 * adding a step here is what makes every storage route perform it.
 */
const POST_ENRICHMENT_STEPS: ReadonlyArray<PostEnrichmentStep> = [
  enrichMediaMetadata,
  enrichLinkPreviews,
];

/**
 * Run every post-ingest enrichment for a batch of just-stored posts.
 *
 * Fire-and-forget by construction: returns void, is never awaited by a caller,
 * and isolates each step so one step's failure can neither abort the others nor
 * reach the ingest that triggered it.
 */
export function enrichIngestedPosts(posts: ReadonlyArray<IngestedPost>): void {
  if (posts.length === 0) return;

  for (const step of POST_ENRICHMENT_STEPS) {
    try {
      step(posts);
    } catch (error) {
      logger.warn('[PostEnrichment] step threw', {
        step: step.name,
        count: posts.length,
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
  }
}
