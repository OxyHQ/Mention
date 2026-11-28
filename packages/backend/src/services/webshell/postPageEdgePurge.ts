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
 * HOW — the caller has COMMITTED its write. {@link purgePostPages} then, for
 * those posts and for the pages that repeat them (`postPageDependents.ts`):
 *  1. evicts the origin's own caches of those posts — the record
 *     (`postDetailCache`) and the OG card (`webShellOgCache`) — because the edge
 *     refills from the origin, and a purge answered from a stale cache would
 *     re-cache the very page it removed;
 *  2. enqueues one BullMQ job per 15 posts (30 URLs, `/p/<id>` and `/p/<id>/`,
 *     Cloudflare's limit per call), delayed a moment and retried with
 *     exponential backoff (`queue/constants.ts`);
 *  3. returns. The worker evicts the origin caches again and calls Cloudflare.
 *
 * NEVER HOLDS THE ACTION — a caller waits at most
 * {@link POST_PAGE_PURGE_QUEUE_DEADLINE_MS}. The queue connection retries with
 * no command timeout, so while queue Redis is unreachable an enqueue stays
 * pending instead of rejecting; it is left running and counted as given up.
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
 * EVERY WEB HOST — the same page is served on the canonical origin and on each
 * alias (`MENTION_WEB_ALIAS_ORIGINS`, mention.org), and each host's edge holds
 * its own copy. Each host is purged in its own zone (`config.edgePurge.zones`,
 * `CLOUDFLARE_PURGE_ZONES`); a host without a zone is skipped and logged once
 * per process. By default only the canonical host has a zone, which is the one
 * purge made before there were aliases (docs/mention-org-domain-move.md).
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
import { findDependentPostIds } from './postPageDependents';
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

/** The longest a caller waits for its purge to be queued. */
export const POST_PAGE_PURGE_QUEUE_DEADLINE_MS = 2_000;

/** Each post has two cached URLs, so one call carries 15 posts. */
const URLS_PER_POST = 2;
const POSTS_PER_CALL = CLOUDFLARE_PURGE_MAX_URLS / URLS_PER_POST;

/** Whether this process purges at all. */
export function isPostPageEdgePurgeEnabled(): boolean {
  return config.edgePurge.enabled;
}

/**
 * The URLs the Cache Rule may hold for one post on one web origin (the
 * canonical one unless named): the handler's route is `/^\/p\/([^/]+)\/?$/`,
 * so the page is cached with and without the slash.
 */
export function postPageUrls(postId: string, origin: string = config.web.origin): string[] {
  const base = `${origin}/p/${encodeURIComponent(postId)}`;
  return [base, `${base}/`];
}

/** One web origin and the Cloudflare zone its pages are cached in. */
export interface PostPagePurgeTarget {
  origin: string;
  zoneId: string;
}

/** Web hosts already reported as having no zone, so each is logged once per process. */
const hostsReportedWithoutZone = new Set<string>();

/**
 * Every web origin (canonical first, then the aliases) paired with its zone.
 * An origin whose host has no zone is left out and logged once.
 */
export function postPagePurgeTargets(): PostPagePurgeTarget[] {
  const targets: PostPagePurgeTarget[] = [];
  for (const origin of [config.web.origin, ...config.web.aliasOrigins]) {
    const host = new URL(origin).hostname.toLowerCase();
    const zone = config.edgePurge.zones.find((candidate) => candidate.host === host);
    if (zone) {
      targets.push({ origin, zoneId: zone.zoneId });
    } else if (!hostsReportedWithoutZone.has(host)) {
      hostsReportedWithoutZone.add(host);
      logger.warn('[EdgePurge] web host has no Cloudflare zone; its post pages are not purged', {
        host,
      });
    }
  }
  return targets;
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
 * Wait for `work`, but never past the deadline. `work` must not reject; past
 * the deadline it keeps running and `onDeadline` reports it.
 */
async function withinQueueDeadline(work: Promise<void>, onDeadline: () => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      onDeadline();
      resolve();
    }, POST_PAGE_PURGE_QUEUE_DEADLINE_MS);
  });
  try {
    await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Purge these posts' pages from the edge, and the pages that repeat them, after
 * the write that changed them has COMMITTED. Resolves whatever happens, within
 * the queue deadline; see the module comment.
 *
 * A delete passes the dependents it read before deleting among `postIds`: they
 * cannot be found afterwards.
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

  await withinQueueDeadline(queueWithDependents(ids, reason, priority), () =>
    recordPostPagePurgeFailure(reason, 'enqueue', ids.length, new Error('queue deadline passed')),
  );
}

/** The posts' own pages first, so a failed dependents read cannot hold them back. */
async function queueWithDependents(
  ids: readonly string[],
  reason: PostPagePurgeReason,
  priority: number,
): Promise<void> {
  await queuePurge(ids, reason, priority);
  let dependents: string[];
  try {
    dependents = await findDependentPostIds(ids);
  } catch (error) {
    recordPostPagePurgeFailure(reason, 'enqueue', ids.length, error);
    return;
  }
  if (dependents.length > 0) await queuePurge(dependents, reason, priority);
}

/** Evict the origin's caches of these posts and queue their purge. Never rejects. */
async function queuePurge(
  ids: readonly string[],
  reason: PostPagePurgeReason,
  priority: number,
): Promise<void> {
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
  // No inline fallback: a sweep is a walk over the author's posts, not
  // something to run detached in the process that received the event.
  const queued = enqueuePostPageEdgePurge(
    { kind: 'author', oxyUserId },
    {
      priority: POST_PAGE_EDGE_PURGE_PRIORITY_AUTHOR,
      delayMs: POST_PAGE_EDGE_PURGE_AUTHOR_DELAY_MS,
      ...(dedupeKey ? { dedupeKey: `author|${oxyUserId}|${dedupeKey}` } : {}),
    },
  ).then(
    () => undefined,
    (error: unknown) => recordPostPagePurgeFailure('author_check', 'enqueue', 0, error),
  );
  await withinQueueDeadline(queued, () =>
    recordPostPagePurgeFailure('author_check', 'enqueue', 0, new Error('queue deadline passed')),
  );
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
  // Every host is attempted even when one fails; the first failure is then
  // rethrown, so BullMQ retries the job (purging an already-purged URL is harmless).
  let failure: unknown;
  for (const target of postPagePurgeTargets()) {
    try {
      await purgeCloudflareUrls(
        ids.flatMap((id) => postPageUrls(id, target.origin)),
        { zoneId: target.zoneId, token },
      );
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
  metrics.incrementCounter(POST_PAGE_PURGED_METRIC, ids.length, { reason });
}
