import { config } from '../../config';
import type { FederatedActorRecord, InstagramGraphSyncResult } from '../../db/federation/actorRecord';
import {
  claimInstagramGraphSync,
  findActorById,
  findActorByUri,
  findInstagramGraphSyncCandidates,
  pinInstagramGraphUserId,
  recordInstagramGraphHistoryDepth,
  releaseInstagramGraphSync,
  setActorRemoteCounts,
} from '../../db/federation/actorRepository';
import { enqueueInstagramGraphSync } from '../../queue/producers';
import { logger } from '../../utils/logger';
import { mapWithConcurrency } from '../../utils/concurrency';
import { INSTAGRAM_AP_BRIDGE_HOSTS } from '../shared/instagramSourceKey';
import {
  DEADLINE_RETRY_MS,
  igUserIdFromActorUri,
  instagramUsernameOfActor,
  isInstagramGraphEnabled,
  NOT_BUSINESS_RECHECK_MS,
  PERIODIC_SYNC_BATCH,
  PERIODIC_SYNC_CONCURRENCY,
  PERIODIC_SYNC_DUE_MS,
  PERIODIC_SYNC_LIMIT,
  PROFILE_VIEW_SYNC_COOLDOWN_MS,
  PROFILE_VIEW_SYNC_LIMIT,
  SYNC_DEADLINE_MS,
  SYNC_LEASE_TTL_MS,
} from './constants';
import { importInstagramMedia, type InstagramImportOptions, type InstagramImportResult } from './importer';

/**
 * WHEN an Instagram account's posts are read, and how much each occasion may
 * spend. Three triggers, one path:
 *
 *  - `profile_view` — a reader opened the profile; one page, interactive budget,
 *    at most every {@link PROFILE_VIEW_SYNC_COOLDOWN_MS}.
 *  - `follow` — a reader followed the account; the configured backfill
 *    (`INSTAGRAM_GRAPH_FOLLOW_BACKFILL_LIMIT`), at most every
 *    {@link PERIODIC_SYNC_DUE_MS} — a follow/unfollow loop, or a thousand
 *    followers, is ONE backfill, not a thousand.
 *  - `periodic` — a followed account's new posts, background budget only.
 *
 * After an account's first successful sync, every trigger stops paging at the
 * first page that holds an already-imported post: everything older is already
 * here. Every trigger takes the per-actor lease first
 * (`claimInstagramGraphSync`), so concurrent views, tasks and job runs make ONE
 * set of Graph calls, and every run stops starting new work after
 * {@link SYNC_DEADLINE_MS} so it always ends inside its lease.
 */

export type InstagramSyncTrigger = 'profile_view' | 'follow' | 'periodic';

/** Is this actor's identity on Instagram (kilogram bridge or Graph)? */
export function isInstagramIdentityActor(actor: Pick<FederatedActorRecord, 'protocol' | 'networkAcct'>): boolean {
  return actor.protocol === 'instagram-graph' || instagramUsernameOfActor(actor) !== undefined;
}

/** Exported for tests. */
export function optionsFor(
  trigger: InstagramSyncTrigger,
  actor: Pick<FederatedActorRecord, 'instagramGraphLastResult' | 'instagramGraphHistoryDepth'>,
  now = Date.now(),
): InstagramImportOptions {
  const deadline = now + SYNC_DEADLINE_MS;
  switch (trigger) {
    case 'profile_view':
      // One page either way; after a successful sync, only what is new.
      return {
        limit: PROFILE_VIEW_SYNC_LIMIT,
        stopAtKnown: actor.instagramGraphLastResult === 'ok',
        kind: 'interactive',
        deadline,
      };
    case 'follow': {
      // The backfill walks history until it has reached the configured depth
      // ONCE (a profile view's single page does not count as having done it);
      // from then on a follow only looks for what is new.
      const limit = config.instagramGraph.followBackfillLimit;
      const walked = actor.instagramGraphHistoryDepth ?? 0;
      return { limit, stopAtKnown: walked >= limit, kind: 'interactive', deadline };
    }
    case 'periodic':
      return { limit: PERIODIC_SYNC_LIMIT, stopAtKnown: true, kind: 'background', deadline };
    default: {
      const exhaustive: never = trigger;
      throw new Error(`unknown Instagram sync trigger ${String(exhaustive)}`);
    }
  }
}

/** Exported for tests. */
export function cooldownFor(trigger: InstagramSyncTrigger): number {
  return trigger === 'profile_view' ? PROFILE_VIEW_SYNC_COOLDOWN_MS : PERIODIC_SYNC_DUE_MS;
}

/**
 * The cooldown stamp an import result earns. `null` = release without stamping:
 * a call we WITHHELD (budget, throttle, bad token, disabled) says nothing about
 * the account, so it is retried at the next opportunity. A run cut short by its
 * deadline stamps `deadline` (a short cooldown). A `partial` run (some post waits for media) stamps `error`:
 * the ordinary cooldown, and — because it is not `ok` — the next run walks
 * history again instead of stopping at the first known post.
 */
export function syncResultFor(outcome: InstagramImportResult['outcome']): InstagramGraphSyncResult | null {
  switch (outcome) {
    case 'ok':
      return 'ok';
    case 'not_business':
      return 'not_business';
    case 'identity_mismatch':
      return 'identity_mismatch';
    case 'deadline':
      // Cut short, not finished: a SHORT cooldown, so the next trigger resumes
      // soon without a stampede of retries while the lease is released.
      return 'deadline';
    case 'budget':
    case 'throttled':
    case 'token_invalid':
    case 'disabled':
      return null;
    default:
      return 'error';
  }
}

/**
 * Run one Instagram sync for `actor` under its lease. Returns null when nothing
 * ran (disabled, not an Instagram identity, no Oxy owner, or another holder /
 * the cooldown owns this actor right now). Never throws.
 */
export async function syncInstagramActor(
  actor: FederatedActorRecord,
  trigger: InstagramSyncTrigger,
): Promise<InstagramImportResult | null> {
  if (!isInstagramGraphEnabled()) return null;
  const username = instagramUsernameOfActor(actor);
  const ownerOxyUserId = actor.oxyUserId;
  if (!username || !ownerOxyUserId) return null;

  const now = new Date();
  let claimed = false;
  try {
    claimed = await claimInstagramGraphSync(actor.id, now, {
      cooldown: new Date(now.getTime() - cooldownFor(trigger)),
      notBusiness: new Date(now.getTime() - NOT_BUSINESS_RECHECK_MS),
      shortRetry: new Date(now.getTime() - DEADLINE_RETRY_MS),
      staleLease: new Date(now.getTime() - SYNC_LEASE_TTL_MS),
    });
  } catch (err) {
    logger.error('[instagram] failed to claim Graph sync', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
  if (!claimed) return null;

  let result: InstagramImportResult | null = null;
  try {
    const isKilogram = actor.protocol === 'activitypub' && INSTAGRAM_AP_BRIDGE_HOSTS.has(actor.domain.toLowerCase());
    // The id the username must still answer with: the pin from the first
    // successful sync, or — for a Graph-only actor — the id in its own URI.
    const expectedIgUserId = actor.instagramGraphUserId
      ?? (actor.protocol === 'instagram-graph' ? igUserIdFromActorUri(actor.uri) : undefined);
    result = await importInstagramMedia(
      {
        username,
        ownerOxyUserId,
        actorUri: actor.uri,
        expectedIgUserId,
        kilogramActorUri: isKilogram ? actor.uri : undefined,
      },
      optionsFor(trigger, actor),
    );

    const answered = result.profile;
    if (answered && (result.outcome === 'ok' || result.outcome === 'partial' || result.outcome === 'deadline')) {
      if (!actor.instagramGraphUserId) await pinInstagramGraphUserId(actor.id, answered.id);
      const walked = result.historyWalked;
      if (walked.items > 0 || walked.exhausted) {
        // An exhausted listing has no deeper history: record it as fully walked.
        const depth = walked.exhausted ? Math.max(walked.items, config.instagramGraph.followBackfillLimit) : walked.items;
        await recordInstagramGraphHistoryDepth(actor.id, depth);
      }
      // An `instagram-graph` actor has no other source for its counts.
      if (actor.protocol === 'instagram-graph') {
        await setActorRemoteCounts(actor.id, {
          followersCount: answered.followers_count,
          followingCount: answered.follows_count,
          postsCount: answered.media_count,
        });
      }
    }
    logger.info('[instagram] Graph sync finished', {
      trigger,
      outcome: result.outcome,
      imported: result.imported,
      deleted: result.deleted,
    });
    return result;
  } catch (err) {
    logger.warn('[instagram] Graph sync failed', { trigger, error: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    const stamp = result ? syncResultFor(result.outcome) : 'error';
    await releaseInstagramGraphSync(actor.id, now, stamp).catch((err) => {
      logger.warn('[instagram] failed to release Graph sync lease', { error: err instanceof Error ? err.message : String(err) });
    });
  }
}

/**
 * A profile view or a follow asked for a sync: queue it on a worker (one per
 * actor and trigger while queued), or — with no queue (local dev, degraded
 * boot) — run it detached in this process. The lease and cooldown still decide
 * inside, so an over-eager caller costs a lookup, not Graph budget.
 */
export function requestInstagramSync(actor: FederatedActorRecord, trigger: 'profile_view' | 'follow'): void {
  void (async () => {
    try {
      if (await enqueueInstagramGraphSync({ actorId: actor.id, trigger })) return;
    } catch (err) {
      logger.warn('[instagram] could not queue Graph sync; running it here', { error: err instanceof Error ? err.message : String(err) });
    }
    await syncInstagramActor(actor, trigger);
  })().catch(() => undefined);
}

/** The queue worker's body: re-read the actor (the job carries only its id) and sync it. */
export async function runQueuedInstagramSync(actorId: string, trigger: 'profile_view' | 'follow'): Promise<void> {
  const actor = await findActorById(actorId);
  if (!actor) return;
  await syncInstagramActor(actor, trigger);
}

/**
 * The periodic job: followed Instagram-identity actors whose sync is due, a
 * small batch at a time, a couple at once. Stops early once a sync reports the
 * budget, a throttle or the token as the obstacle — the rest of the batch would
 * hit the same wall.
 */
export async function runPeriodicInstagramSync(): Promise<{ synced: number; imported: number }> {
  if (!isInstagramGraphEnabled()) return { synced: 0, imported: 0 };
  const now = Date.now();
  const candidates = await findInstagramGraphSyncCandidates(
    {
      due: new Date(now - PERIODIC_SYNC_DUE_MS),
      notBusiness: new Date(now - NOT_BUSINESS_RECHECK_MS),
      shortRetry: new Date(now - DEADLINE_RETRY_MS),
    },
    PERIODIC_SYNC_BATCH,
  );
  if (candidates.length === 0) return { synced: 0, imported: 0 };

  let blocked = false;
  let synced = 0;
  let imported = 0;
  await mapWithConcurrency(candidates, PERIODIC_SYNC_CONCURRENCY, async (candidate) => {
    if (blocked) return;
    const actor = await findActorByUri(candidate.uri);
    if (!actor) return;
    const result = await syncInstagramActor(actor, 'periodic');
    if (!result) return;
    synced += 1;
    imported += result.imported;
    if (['budget', 'throttled', 'token_invalid', 'disabled'].includes(result.outcome)) blocked = true;
  });
  logger.info('[instagram] periodic Graph sync', { candidates: candidates.length, synced, imported, blocked });
  return { synced, imported };
}
