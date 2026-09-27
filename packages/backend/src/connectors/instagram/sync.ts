import { config } from '../../config';
import type { FederatedActorRecord, InstagramGraphSyncResult } from '../../db/federation/actorRecord';
import {
  claimInstagramGraphSync,
  findActorByUri,
  findInstagramGraphSyncCandidates,
  releaseInstagramGraphSync,
  setActorRemoteCounts,
} from '../../db/federation/actorRepository';
import { logger } from '../../utils/logger';
import { mapWithConcurrency } from '../../utils/concurrency';
import { INSTAGRAM_AP_BRIDGE_HOSTS } from '../shared/instagramSourceKey';
import {
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
 *    (`INSTAGRAM_GRAPH_FOLLOW_BACKFILL_LIMIT`), no cooldown.
 *  - `periodic` — a followed account's new posts; newest first, stopping at the
 *    first post already here, background budget only.
 *
 * Every trigger takes the per-actor lease first (`claimInstagramGraphSync`), so
 * any number of concurrent views, tasks and job runs make ONE set of Graph calls.
 */

export type InstagramSyncTrigger = 'profile_view' | 'follow' | 'periodic';

/** Is this actor's identity on Instagram (kilogram bridge or Graph)? */
export function isInstagramIdentityActor(actor: Pick<FederatedActorRecord, 'protocol' | 'networkAcct'>): boolean {
  return actor.protocol === 'instagram-graph' || instagramUsernameOfActor(actor) !== undefined;
}

function optionsFor(trigger: InstagramSyncTrigger): InstagramImportOptions {
  switch (trigger) {
    case 'profile_view':
      return { limit: PROFILE_VIEW_SYNC_LIMIT, stopAtKnown: false, kind: 'interactive' };
    case 'follow':
      return { limit: config.instagramGraph.followBackfillLimit, stopAtKnown: false, kind: 'interactive' };
    case 'periodic':
      return { limit: PERIODIC_SYNC_LIMIT, stopAtKnown: true, kind: 'background' };
    default: {
      const exhaustive: never = trigger;
      throw new Error(`unknown Instagram sync trigger ${String(exhaustive)}`);
    }
  }
}

function cooldownFor(trigger: InstagramSyncTrigger): number {
  if (trigger === 'profile_view') return PROFILE_VIEW_SYNC_COOLDOWN_MS;
  if (trigger === 'periodic') return PERIODIC_SYNC_DUE_MS;
  return 0;
}

/**
 * The cooldown stamp an import result earns. `null` = release without stamping:
 * a call we WITHHELD (budget, throttle, bad token, disabled) says nothing about
 * the account, so it must be retried at the next opportunity.
 */
export function syncResultFor(outcome: InstagramImportResult['outcome']): InstagramGraphSyncResult | null {
  switch (outcome) {
    case 'ok':
      return 'ok';
    case 'not_business':
      return 'not_business';
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
    result = await importInstagramMedia(
      {
        username,
        ownerOxyUserId,
        actorUri: actor.uri,
        expectedIgUserId: actor.protocol === 'instagram-graph' ? igUserIdFromActorUri(actor.uri) : undefined,
        kilogramActorUri: isKilogram ? actor.uri : undefined,
      },
      optionsFor(trigger),
    );

    // An `instagram-graph` actor has no other source for its counts.
    if (actor.protocol === 'instagram-graph' && result.outcome === 'ok' && result.profile) {
      await setActorRemoteCounts(actor.id, {
        followersCount: result.profile.followers_count,
        followingCount: result.profile.follows_count,
        postsCount: result.profile.media_count,
      });
    }
    logger.info('[instagram] Graph sync finished', {
      trigger,
      outcome: result.outcome,
      imported: result.imported,
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

/** Detached {@link syncInstagramActor}. */
export function syncInstagramActorInBackground(actor: FederatedActorRecord, trigger: InstagramSyncTrigger): void {
  void syncInstagramActor(actor, trigger).catch(() => undefined);
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
    new Date(now - PERIODIC_SYNC_DUE_MS),
    new Date(now - NOT_BUSINESS_RECHECK_MS),
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
    if (syncResultFor(result.outcome) === null) blocked = true;
  });
  logger.info('[instagram] periodic Graph sync', { candidates: candidates.length, synced, imported, blocked });
  return { synced, imported };
}
