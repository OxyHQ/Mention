/**
 * Take a post's public page off Cloudflare's edge the moment it stops being
 * public or changes.
 *
 * WHY — a Cloudflare Cache Rule (`mention_post_pages_edge_cache`, oxy-infra
 * runbook 72) serves anonymous `GET /p/<id>` from the edge for the origin's
 * `s-maxage=300`. Without this, a post that was deleted, hidden by moderation,
 * edited, or whose author was suspended, made private or erased stayed readable
 * there for up to five minutes. The origin decides visibility fresh on every
 * request (`routes/webShell.routes.ts`); this makes the edge ask it again.
 *
 * HOW — the caller has COMMITTED its write. {@link purgePostPages} then:
 *  1. evicts the origin's own caches of those posts — the record
 *     (`postDetailCache`) and the OG card (`webShellOgCache`) — because the edge
 *     refills from the origin, and a purge answered from a stale cache would
 *     re-cache the very page it removed;
 *  2. enqueues one BullMQ job per 15 posts (30 URLs, `/p/<id>` and `/p/<id>/`,
 *     Cloudflare's limit per call), delayed a moment and retried with
 *     exponential backoff (`queue/constants.ts`);
 *  3. returns. The worker evicts the origin caches again and calls Cloudflare.
 *
 * NEVER FAILS THE ACTION — every entry point here resolves, whatever happens.
 * A purge that cannot be enqueued, or that Cloudflare refuses until the retries
 * run out, is logged as {@link POST_PAGE_PURGE_GAVE_UP_LOG} (a CloudWatch alarm
 * watches for that line, oxy-infra runbook 73) and counted as
 * {@link POST_PAGE_PURGE_FAILED_METRIC}. The page then leaves the edge when its
 * `s-maxage` runs out, which is exactly the behaviour before this existed.
 *
 * OFF unless `config.edgePurge.enabled` (the flag, ON in production, AND the
 * token): every entry point is then a no-op.
 *
 * NOT COVERED — a URL with a query string (`/p/<id>?utm_source=x`) is its own
 * cache entry, and purge-by-URL removes only the URLs it names. Those entries
 * still expire after `s-maxage`.
 */
import { config, getCloudflarePurgeToken } from '../../config';
import { enqueuePostPageEdgePurge } from '../../queue/producers';
import {
  POST_PAGE_EDGE_PURGE_AUTHOR_DELAY_MS,
  POST_PAGE_EDGE_PURGE_DELAY_MS,
  POST_PAGE_EDGE_PURGE_PRIORITY_ACTION,
  POST_PAGE_EDGE_PURGE_PRIORITY_AUTHOR,
  POST_PAGE_EDGE_PURGE_PRIORITY_SWEEP,
} from '../../queue/constants';
import type { PostPagePurgeReason } from '../../queue/types';
import { invalidateMany as invalidatePostDetails } from '../posts/postDetailCache';
import { invalidatePostOgCards } from './webShellOgCache';
import { CLOUDFLARE_PURGE_MAX_URLS, purgeCloudflareUrls } from './cloudflarePurgeClient';
import { logger } from '../../utils/logger';
import { metrics } from '../../utils/metrics';

export type { PostPagePurgeReason };

/** Purges that ran out of retries, or never reached the queue. Labelled by `reason` and `stage`. */
export const POST_PAGE_PURGE_FAILED_METRIC = 'post_page_edge_purge_failed_total';

/** Posts whose pages Cloudflare confirmed purged. Labelled by `reason`. */
export const POST_PAGE_PURGED_METRIC = 'post_page_edge_purged_total';

/**
 * The log line the CloudWatch alarm matches (oxy-infra `alerts.tf`). Changing
 * it silently disarms that alarm: change both together.
 */
export const POST_PAGE_PURGE_GAVE_UP_LOG = '[EdgePurge] post page purge gave up';

/** Each post has two cached URLs, so one call carries 15 posts. */
const URLS_PER_POST = 2;
const POSTS_PER_CALL = CLOUDFLARE_PURGE_MAX_URLS / URLS_PER_POST;

/** Whether this process purges at all. */
export function isPostPageEdgePurgeEnabled(): boolean {
  return config.edgePurge.enabled;
}

/**
 * The URLs the Cache Rule may hold for one post: the handler's route is
 * `/^\/p\/([^/]+)\/?$/`, so the page is cached with and without the slash.
 */
export function postPageUrls(postId: string): string[] {
  const base = `${config.web.origin}/p/${encodeURIComponent(postId)}`;
  return [base, `${base}/`];
}

function uniqueIds(postIds: readonly string[]): string[] {
  return [...new Set(postIds.filter((id) => typeof id === 'string' && id.length > 0))];
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

/** Evict the origin's caches of these posts, so the edge refills from the current row. */
async function evictOriginCaches(postIds: readonly string[]): Promise<void> {
  await Promise.all([invalidatePostDetails(postIds), invalidatePostOgCards(postIds)]);
}

/**
 * Log and count a purge that will not happen. Never throws: it is what every
 * failure path here ends in.
 */
export function recordPostPagePurgeFailure(
  reason: PostPagePurgeReason | 'author_check',
  stage: 'enqueue' | 'purge' | 'inline',
  posts: number,
  error: unknown,
): void {
  try {
    metrics.incrementCounter(POST_PAGE_PURGE_FAILED_METRIC, 1, { reason, stage });
    logger.error(POST_PAGE_PURGE_GAVE_UP_LOG, {
      reason,
      stage,
      posts,
      error: error instanceof Error ? error.message : String(error),
    });
  } catch {
    // A failing logger must not turn a lost purge into a failed action.
  }
}

/**
 * Purge these posts' pages from the edge, after the write that changed them
 * has COMMITTED. Resolves whatever happens; see the module comment.
 *
 * `priority: 'sweep'` is for batches swept on an author's behalf, so a person's
 * own delete or edit is never queued behind someone else's thousand posts.
 */
export async function purgePostPages(
  postIds: readonly string[],
  reason: PostPagePurgeReason,
  options: { priority?: 'action' | 'sweep' } = {},
): Promise<void> {
  if (!isPostPageEdgePurgeEnabled()) return;
  const ids = uniqueIds(postIds);
  if (ids.length === 0) return;
  const priority =
    options.priority === 'sweep'
      ? POST_PAGE_EDGE_PURGE_PRIORITY_SWEEP
      : POST_PAGE_EDGE_PURGE_PRIORITY_ACTION;

  try {
    await evictOriginCaches(ids);
  } catch (error) {
    // Fail-open like every cache here; the worker evicts again before purging.
    logger.warn('[EdgePurge] origin cache eviction failed', {
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  for (const postIdsInCall of chunk(ids, POSTS_PER_CALL)) {
    try {
      const queued = await enqueuePostPageEdgePurge(
        { kind: 'posts', postIds: postIdsInCall, reason },
        { priority, delayMs: POST_PAGE_EDGE_PURGE_DELAY_MS },
      );
      if (!queued) purgeInline(postIdsInCall, reason);
    } catch (error) {
      recordPostPagePurgeFailure(reason, 'enqueue', postIdsInCall.length, error);
    }
  }
}

/**
 * No queue (no Redis: a local run). One detached attempt, so the caller still
 * never waits on Cloudflare.
 */
function purgeInline(postIds: string[], reason: PostPagePurgeReason): void {
  runPostPagePurge(postIds, reason).catch((error: unknown) =>
    recordPostPagePurgeFailure(reason, 'inline', postIds.length, error),
  );
}

/**
 * Re-check this author and, if Mention no longer shows them, purge every public
 * page of theirs (`authorPostPagePurge.ts`). For a change Mention cannot see
 * the content of — an Oxy account change, a profile made private — so the job
 * asks the same question the page asks rather than trusting the trigger.
 *
 * `dedupeKey` names the trigger: every task receives an Oxy invalidation, and
 * the copies collapse into one job. Resolves whatever happens.
 */
export async function scheduleAuthorPostPagePurge(
  oxyUserId: string,
  dedupeKey?: string,
): Promise<void> {
  if (!isPostPageEdgePurgeEnabled() || !oxyUserId) return;
  try {
    // No inline fallback: a sweep is a walk over the author's posts, not
    // something to run detached in the process that received the event.
    await enqueuePostPageEdgePurge(
      { kind: 'author', oxyUserId },
      {
        priority: POST_PAGE_EDGE_PURGE_PRIORITY_AUTHOR,
        delayMs: POST_PAGE_EDGE_PURGE_AUTHOR_DELAY_MS,
        ...(dedupeKey ? { dedupeKey: `author|${oxyUserId}|${dedupeKey}` } : {}),
      },
    );
  } catch (error) {
    recordPostPagePurgeFailure('author_check', 'enqueue', 0, error);
  }
}

/**
 * The worker half: evict the origin caches once more, then ask Cloudflare to
 * drop the pages. Throws, so BullMQ retries; `postPageEdgePurgeJob.ts` decides
 * when to give up. A flag switched off since the job was queued drops it.
 */
export async function runPostPagePurge(
  postIds: readonly string[],
  reason: PostPagePurgeReason,
): Promise<void> {
  const token = getCloudflarePurgeToken();
  if (!isPostPageEdgePurgeEnabled() || !token) return;
  const ids = uniqueIds(postIds);
  if (ids.length === 0) return;

  await evictOriginCaches(ids);
  await purgeCloudflareUrls(ids.flatMap(postPageUrls), {
    zoneId: config.edgePurge.zoneId,
    token,
  });
  metrics.incrementCounter(POST_PAGE_PURGED_METRIC, ids.length, { reason });
}
