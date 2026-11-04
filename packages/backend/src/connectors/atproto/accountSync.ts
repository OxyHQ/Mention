/**
 * Reading a Bluesky account's posts: the one-page read every trigger uses
 * ({@link importAccountPosts} — a profile view, a follow, the periodic sync),
 * and the atproto half of the two periodic federation jobs
 * (`syncFollowedActorsPosts`, `syncRecentOutboxBackfills`), reached through
 * `AtprotoConnector`.
 *
 * All of it is `app.bsky.feed.getAuthorFeed` through the one post mapper, over
 * the shared XRPC client, which caps requests per host and backs off a
 * rate-limited AppView. Nothing here talks to Bluesky directly.
 *
 *  - {@link syncFollowedAtprotoAccounts}: the newest page of every followed
 *    account that is due, a bounded batch per tick, the longest-waiting first.
 *    Due-ness is `last_outbox_sync_at`, the stamp a profile view writes too, so
 *    the two never fetch the same account back to back, and the load is spread
 *    across ticks rather than arriving at once.
 *  - {@link advanceAtprotoHistoryBackfills}: an account's older posts, a few
 *    pages per run, resumed from a persisted cursor and capped per account.
 *    Paginated `getAuthorFeed` rather than the account's repository CAR
 *    (`com.atproto.sync.getRepo`): see `docs/bluesky-ingestion.md`.
 */

import {
  claimOutboxBackfill,
  findAtprotoFollowedSyncCandidates,
  findAtprotoHistoryBackfillCandidates,
  stampLastOutboxSyncAt,
  updateOutboxBackfill,
  type AtprotoHistoryCandidate,
} from '../../db/federation/actorRepository';
import type { FetchPostsOptions, FetchPostsResult } from '@oxy.so/federation';
import { mapWithConcurrency } from '../../utils/concurrency';
import { logger } from '../../utils/logger';
import { ATPROTO_ENABLED } from './constants';
import { importAuthorFeed } from './post.mapper';
import { fetchAndUpsertAtprotoProfile } from './profile.mapper';
import { XrpcError } from './xrpcClient';

/** A followed account is re-read once its last import is older than this. */
export const FOLLOWED_SYNC_DUE_MS = 15 * 60 * 1000;

/** Followed accounts read per tick; the rest wait for the next one. */
export const FOLLOWED_SYNC_BATCH = 100;

/** Followed accounts read at once. */
export const FOLLOWED_SYNC_CONCURRENCY = 4;

/** Feed items per followed-account read — the profile-view page size. */
export const FOLLOWED_SYNC_PAGE_SIZE = 20;

/** Feed items per history page (the AppView's maximum). */
export const HISTORY_PAGE_SIZE = 100;

/** History pages read per account in all: the per-account cap. */
export const HISTORY_MAX_PAGES = 10;

/** History pages read per account per run; the cursor carries the rest over. */
export const HISTORY_PAGES_PER_RUN = 5;

/** Accounts whose history one run advances. */
export const HISTORY_ACCOUNTS_PER_RUN = 10;

/**
 * An account nobody follows still has its whole history read when it is this
 * small (two pages) and someone has opened it — cheap enough to do on discovery.
 */
export const HISTORY_CHEAP_POSTS = 200;

/** How long one run holds an account's backfill lease. */
const HISTORY_LEASE_MS = 10 * 60 * 1000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read one author-feed page of an account: refresh its profile (so its Oxy user
 * is known and no post is orphaned), then import the page. Throws `XrpcError`
 * when the AppView cannot be read.
 */
export async function importAccountPosts(
  externalId: string,
  opts: FetchPostsOptions = {},
): Promise<FetchPostsResult> {
  const actor = await fetchAndUpsertAtprotoProfile(externalId);
  if (!actor) return { posts: [] };
  if (!actor.oxyUserId) {
    logger.warn('[atproto] fetchPosts skipped backfill without a resolved Oxy user');
    return { posts: [] };
  }
  const { posts, cursor } = await importAuthorFeed(actor, {
    limit: opts.limit,
    cursor: opts.cursor,
  });
  return { posts, cursor };
}

/** Read the newest page of each followed Bluesky account that is due. */
export async function syncFollowedAtprotoAccounts(now: Date = new Date()): Promise<number> {
  if (!ATPROTO_ENABLED) return 0;
  const due = new Date(now.getTime() - FOLLOWED_SYNC_DUE_MS);
  const candidates = await findAtprotoFollowedSyncCandidates(due, FOLLOWED_SYNC_BATCH);
  if (candidates.length === 0) return 0;

  await mapWithConcurrency(candidates, FOLLOWED_SYNC_CONCURRENCY, async (candidate) => {
    try {
      await importAccountPosts(candidate.uri, { limit: FOLLOWED_SYNC_PAGE_SIZE });
    } catch (err) {
      logger.debug('[atproto] followed account sync failed', { error: errorMessage(err) });
    }
    // A failed read is still a finished attempt (the profile-view rule): the
    // account goes to the back of the queue instead of being retried every tick.
    await stampLastOutboxSyncAt(candidate.id);
  });
  logger.info('[atproto] synced followed accounts', { count: candidates.length });
  return candidates.length;
}

/** Advance the post history of the accounts that are due one. */
export async function advanceAtprotoHistoryBackfills(now: Date = new Date()): Promise<number> {
  if (!ATPROTO_ENABLED) return 0;
  const candidates = await findAtprotoHistoryBackfillCandidates(
    now,
    HISTORY_CHEAP_POSTS,
    HISTORY_ACCOUNTS_PER_RUN,
  );
  for (const candidate of candidates) await advanceHistory(candidate, now);
  if (candidates.length > 0) {
    logger.info('[atproto] advanced history backfills', { count: candidates.length });
  }
  return candidates.length;
}

async function advanceHistory(candidate: AtprotoHistoryCandidate, now: Date): Promise<void> {
  const claimed = await claimOutboxBackfill(candidate.id, now, {
    status: 'pending',
    lockedUntil: new Date(now.getTime() + HISTORY_LEASE_MS),
    lastRunAt: now,
  });
  if (!claimed) return;

  const state = candidate.outboxBackfill;
  let cursor = state.cursorUrl;
  let pageCount = state.pageCount;
  let importedCount = state.importedCount;
  try {
    const actor = await fetchAndUpsertAtprotoProfile(candidate.uri);
    if (!actor?.oxyUserId) throw new Error('profile unavailable');

    let reachedEnd = false;
    for (let run = 0; run < HISTORY_PAGES_PER_RUN && pageCount < HISTORY_MAX_PAGES; run++) {
      const page = await importAuthorFeed(actor, { limit: HISTORY_PAGE_SIZE, cursor });
      pageCount += 1;
      importedCount += page.posts.length;
      cursor = page.cursor;
      if (!cursor) {
        reachedEnd = true;
        break;
      }
    }
    const complete = reachedEnd || pageCount >= HISTORY_MAX_PAGES;
    await updateOutboxBackfill(candidate.id, {
      status: complete ? 'complete' : 'pending',
      cursorUrl: complete ? null : (cursor ?? null),
      pageCount,
      importedCount,
      lockedUntil: null,
      completedAt: complete ? new Date() : null,
      lastError: null,
    });
  } catch (err) {
    // The AppView answers 400 for an account it will never serve (deleted,
    // taken down, deactivated); anything else may pass and is retried.
    await updateOutboxBackfill(candidate.id, {
      status: err instanceof XrpcError && err.status === 400 ? 'unavailable' : 'failed',
      cursorUrl: cursor ?? null,
      pageCount,
      importedCount,
      lockedUntil: null,
      lastError: errorMessage(err).slice(0, 500),
    });
  }
}
