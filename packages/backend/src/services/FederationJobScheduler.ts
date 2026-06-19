import { logger } from '../utils/logger';
import type { Types } from 'mongoose';
import { FEDERATION_ENABLED, extractActorUriFromActivityId } from '../utils/federation/constants';
import FederatedActor, { type FederatedOutboxBackfillState } from '../models/FederatedActor';
import FederatedFollow from '../models/FederatedFollow';
import FederationDeliveryQueue, { getNextRetryTime } from '../models/FederationDeliveryQueue';
import { Post } from '../models/Post';
import { federationService } from './FederationService';
import { runCacheWorkerOnce } from './mediaCache/cacheWorker';
import { runEvictionOnce } from './mediaCache/evictionJob';
import { isMediaCacheEnabled } from './mediaCache/oxyMediaStore';
import {
  MEDIA_CACHE_EVICTION_INTERVAL_MS,
  MEDIA_CACHE_WORKER_INTERVAL_MS,
} from './mediaCache/constants';

/** Staleness threshold after which an actor profile is re-fetched. */
const ACTOR_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Max number of stale actors refreshed per scheduled run. */
const ACTOR_REFRESH_BATCH_SIZE = 50;

/** Import at most the 100 most recent importable outbox activities per actor. */
const OUTBOX_RECENT_BACKFILL_LIMIT = 100;

/** Per-run cap for one actor; larger history is advanced by persisted cursor. */
const OUTBOX_RECENT_BACKFILL_BATCH_SIZE = 20;

/** Bound page fan-out per actor/run; the cursor continues on the next scheduler tick. */
const OUTBOX_RECENT_BACKFILL_MAX_PAGES_PER_RUN = 5;

/** Number of actors advanced per scheduler run. */
const OUTBOX_RECENT_BACKFILL_ACTOR_BATCH_SIZE = 10;

/** Per-actor distributed lock TTL for recent outbox backfill. */
const OUTBOX_RECENT_BACKFILL_LOCK_MS = 10 * 60 * 1000;

type RecentOutboxBackfillActor = {
  _id: Types.ObjectId;
  uri: string;
  acct: string;
  outboxUrl?: string;
  oxyUserId?: string;
  outboxBackfill?: FederatedOutboxBackfillState;
};

class FederationJobScheduler {
  private actorRefreshInterval: ReturnType<typeof setInterval> | null = null;
  private deliveryRetryInterval: ReturnType<typeof setInterval> | null = null;
  private outboxSyncInterval: ReturnType<typeof setInterval> | null = null;
  private outboxBackfillInterval: ReturnType<typeof setInterval> | null = null;
  private mediaCacheWorkerInterval: ReturnType<typeof setInterval> | null = null;
  private mediaCacheEvictionInterval: ReturnType<typeof setInterval> | null = null;

  // Startup delay timeout handles (cleared in stop())
  private backfillTimeout: ReturnType<typeof setTimeout> | null = null;
  private initialSyncTimeout: ReturnType<typeof setTimeout> | null = null;

  // Overlap guards — prevent concurrent runs when intervals fire faster than jobs complete
  private isSyncFollowedActorsPostsRunning = false;
  private isSyncRecentOutboxBackfillsRunning = false;
  private isBackfillFederatedPostOxyUserIdsRunning = false;
  private isRetryFailedDeliveriesRunning = false;
  private isMediaCacheWorkerRunning = false;
  private isMediaCacheEvictionRunning = false;

  start(): void {
    if (!FEDERATION_ENABLED) {
      logger.info('Federation disabled — job scheduler not started');
      return;
    }

    // Refresh stale actor profiles every 6 hours
    this.actorRefreshInterval = setInterval(() => {
      this.refreshStaleActors().catch((err) =>
        logger.error('Actor refresh job failed:', err)
      );
    }, 6 * 60 * 60 * 1000);

    // Retry failed deliveries every minute
    this.deliveryRetryInterval = setInterval(() => {
      this.retryFailedDeliveries().catch((err) =>
        logger.error('Delivery retry job failed:', err)
      );
    }, 60 * 1000);

    this.outboxSyncInterval = setInterval(() => {
      this.syncFollowedActorsPosts().catch((err) =>
        logger.error('Outbox sync job failed:', err)
      );
    }, 15 * 60 * 1000);

    this.outboxBackfillInterval = setInterval(() => {
      this.syncRecentOutboxBackfills().catch((err) =>
        logger.error('Recent outbox backfill job failed:', err)
      );
    }, 15 * 60 * 1000);

    // Media-cache worker + eviction intervals are only created when the cache is
    // enabled; while disabled they would no-op every tick, so we avoid arming the
    // timers at all. Enabling the cache requires a redeploy, so creating them at
    // boot is sufficient (no runtime flip to observe).
    if (isMediaCacheEnabled()) {
      // Drain pending federated-media cache jobs (download remote → upload to Oxy).
      this.mediaCacheWorkerInterval = setInterval(() => {
        this.runMediaCacheWorker().catch((err) =>
          logger.error('Media cache worker job failed:', err)
        );
      }, MEDIA_CACHE_WORKER_INTERVAL_MS);

      // Evict idle cached media from Oxy S3 (activity-based TTL).
      this.mediaCacheEvictionInterval = setInterval(() => {
        this.runMediaCacheEviction().catch((err) =>
          logger.error('Media cache eviction job failed:', err)
        );
      }, MEDIA_CACHE_EVICTION_INTERVAL_MS);

    }

    // Stagger startup tasks to let DB connections warm up
    this.backfillTimeout = setTimeout(() => {
      this.backfillFederatedPostOxyUserIds().catch((err) =>
        logger.error('Backfill federated post oxyUserIds failed:', err)
      );
    }, 10 * 1000);

    this.initialSyncTimeout = setTimeout(() => {
      this.syncFollowedActorsPosts().catch((err) =>
        logger.error('Initial outbox sync failed:', err)
      );
      this.syncRecentOutboxBackfills().catch((err) =>
        logger.error('Initial recent outbox backfill failed:', err)
      );
    }, 30 * 1000);

    logger.info('Federation job scheduler started');
  }

  stop(): void {
    if (this.actorRefreshInterval) {
      clearInterval(this.actorRefreshInterval);
      this.actorRefreshInterval = null;
    }
    if (this.deliveryRetryInterval) {
      clearInterval(this.deliveryRetryInterval);
      this.deliveryRetryInterval = null;
    }
    if (this.outboxSyncInterval) {
      clearInterval(this.outboxSyncInterval);
      this.outboxSyncInterval = null;
    }
    if (this.outboxBackfillInterval) {
      clearInterval(this.outboxBackfillInterval);
      this.outboxBackfillInterval = null;
    }
    if (this.mediaCacheWorkerInterval) {
      clearInterval(this.mediaCacheWorkerInterval);
      this.mediaCacheWorkerInterval = null;
    }
    if (this.mediaCacheEvictionInterval) {
      clearInterval(this.mediaCacheEvictionInterval);
      this.mediaCacheEvictionInterval = null;
    }
    if (this.backfillTimeout) {
      clearTimeout(this.backfillTimeout);
      this.backfillTimeout = null;
    }
    if (this.initialSyncTimeout) {
      clearTimeout(this.initialSyncTimeout);
      this.initialSyncTimeout = null;
    }
    logger.info('Federation job scheduler stopped');
  }

  /**
   * Refresh stale (>24h) actor profiles so their avatar/banner/display name stay
   * current. Covers BOTH followed actors AND any federated actor that has been
   * resolved/viewed locally (i.e. has an oxyUserId, meaning a Mention user can
   * land on its profile). The avatar refresh is FORCED so Oxy re-downloads and
   * replaces the federated avatar, and the banner is re-synced as part of the
   * full fetch.
   */
  private async refreshStaleActors(): Promise<void> {
    const staleThreshold = new Date(Date.now() - ACTOR_STALE_MS);

    // Actors that have active follows (followed in either direction).
    const followedUris = await FederatedFollow.distinct('remoteActorUri', {
      status: 'accepted',
    });

    // Refresh anything that is stale AND either followed or has been resolved
    // locally (oxyUserId set ⇒ a Mention user can view this profile). This keeps
    // viewed-but-not-followed profiles fresh too.
    const staleActors = await FederatedActor.find({
      $and: [
        {
          $or: [
            { lastFetchedAt: { $lt: staleThreshold } },
            { lastFetchedAt: null },
          ],
        },
        {
          $or: [
            ...(followedUris.length > 0 ? [{ uri: { $in: followedUris } }] : []),
            { oxyUserId: { $ne: null } },
          ],
        },
      ],
    })
      .select('uri acct')
      .limit(ACTOR_REFRESH_BATCH_SIZE) // Process in batches to avoid fan-out storms
      .lean();

    if (staleActors.length === 0) return;

    logger.info(`[FedSync] Refreshing ${staleActors.length} stale actor profiles (forcing avatar refresh)`);

    // Bounded concurrency to avoid overwhelming remote servers.
    const CONCURRENCY = 3;
    for (let i = 0; i < staleActors.length; i += CONCURRENCY) {
      const batch = staleActors.slice(i, i + CONCURRENCY);
      await Promise.allSettled(
        batch.map((actor) =>
          // forceAvatarRefresh=true → Oxy re-downloads/replaces the avatar.
          federationService.fetchRemoteActor(actor.uri, true, actor.acct).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            logger.debug(`[FedSync] Failed to refresh actor ${actor.uri}: ${message}`);
          })
        )
      );
    }
  }

  /**
   * Pull new posts from the outbox of each remotely-followed actor.
   * Catches up on posts that may have been missed by inbox push delivery.
   */
  private async syncFollowedActorsPosts(): Promise<void> {
    if (this.isSyncFollowedActorsPostsRunning) {
      logger.debug('[FedSync] syncFollowedActorsPosts already running, skipping');
      return;
    }
    this.isSyncFollowedActorsPostsRunning = true;
    try {
      const followedActorUris = await FederatedFollow.distinct('remoteActorUri', {
        direction: 'outbound',
        status: 'accepted',
      });

      if (followedActorUris.length === 0) return;

      const actors = await FederatedActor.find({
        uri: { $in: followedActorUris },
        outboxUrl: { $ne: null },
      })
        .select('uri acct outboxUrl oxyUserId')
        .lean();

      if (actors.length === 0) return;

      logger.info(`[FedSync] Syncing outbox posts for ${actors.length} followed actors`);

      // Bounded concurrency to avoid overwhelming remote servers
      const CONCURRENCY = 3;
      for (let i = 0; i < actors.length; i += CONCURRENCY) {
        const batch = actors.slice(i, i + CONCURRENCY);
        await Promise.allSettled(
          batch.map((actor) =>
            federationService.syncOutboxPosts(actor, 20).catch((err) =>
              logger.debug(`[FedSync] Outbox sync failed for ${actor.acct}:`, err)
            )
          )
        );
      }
    } finally {
      this.isSyncFollowedActorsPostsRunning = false;
    }
  }

  /**
   * Backfill the recent historical window for resolved federated actors.
   *
   * This is intentionally separate from `syncFollowedActorsPosts()`:
   * - the followed sync always checks the latest page for new content;
   * - this job advances an opaque ActivityPub cursor until the 100 most recent
   *   importable activities have been inspected, then stops for that actor.
   */
  private async syncRecentOutboxBackfills(): Promise<void> {
    if (this.isSyncRecentOutboxBackfillsRunning) {
      logger.debug('[FedSync] syncRecentOutboxBackfills already running, skipping');
      return;
    }

    this.isSyncRecentOutboxBackfillsRunning = true;
    try {
      const now = new Date();
      const actors = await FederatedActor.find({
        outboxUrl: { $exists: true, $ne: null },
        oxyUserId: { $ne: null },
        $and: [
          {
            $or: [
              { 'outboxBackfill.status': { $exists: false } },
              { 'outboxBackfill.status': { $in: ['pending', 'failed'] } },
              { $expr: { $ne: ['$outboxBackfill.outboxUrl', '$outboxUrl'] } },
            ],
          },
          {
            $or: [
              { 'outboxBackfill.lockedUntil': { $exists: false } },
              { 'outboxBackfill.lockedUntil': null },
              { 'outboxBackfill.lockedUntil': { $lte: now } },
            ],
          },
        ],
      })
        .select('uri acct outboxUrl oxyUserId outboxBackfill')
        .sort({ 'outboxBackfill.lastRunAt': 1, updatedAt: 1 })
        .limit(OUTBOX_RECENT_BACKFILL_ACTOR_BATCH_SIZE)
        .lean<RecentOutboxBackfillActor[]>();

      if (actors.length === 0) return;

      logger.info(`[FedSync] Advancing recent outbox backfill for ${actors.length} actors`);

      for (const actor of actors) {
        await this.runRecentOutboxBackfillForActor(actor);
      }
    } finally {
      this.isSyncRecentOutboxBackfillsRunning = false;
    }
  }

  private async runRecentOutboxBackfillForActor(actor: RecentOutboxBackfillActor): Promise<void> {
    const outboxUrl = actor.outboxUrl;
    if (!outboxUrl) return;

    const previousState = actor.outboxBackfill;
    const outboxChanged = Boolean(previousState?.outboxUrl && previousState.outboxUrl !== outboxUrl);
    const previousProcessedCount = outboxChanged ? 0 : Math.max(0, previousState?.processedCount ?? 0);
    const previousImportedCount = outboxChanged ? 0 : Math.max(0, previousState?.importedCount ?? 0);
    const previousExistingCount = outboxChanged ? 0 : Math.max(0, previousState?.existingCount ?? 0);
    const previousPageCount = outboxChanged ? 0 : Math.max(0, previousState?.pageCount ?? 0);

    if (!outboxChanged && previousProcessedCount >= OUTBOX_RECENT_BACKFILL_LIMIT) {
      await FederatedActor.updateOne(
        { _id: actor._id },
        {
          $set: {
            'outboxBackfill.status': 'complete',
            'outboxBackfill.outboxUrl': outboxUrl,
            'outboxBackfill.processedCount': OUTBOX_RECENT_BACKFILL_LIMIT,
            'outboxBackfill.completedAt': new Date(),
          },
          $unset: {
            'outboxBackfill.cursorUrl': '',
            'outboxBackfill.lockedUntil': '',
            'outboxBackfill.lastError': '',
          },
        },
      );
      return;
    }

    const now = new Date();
    const lockUntil = new Date(now.getTime() + OUTBOX_RECENT_BACKFILL_LOCK_MS);
    const claimUpdate: {
      $set: Record<string, unknown>;
      $unset: Record<string, ''>;
    } = {
      $set: {
        'outboxBackfill.status': 'pending',
        'outboxBackfill.outboxUrl': outboxUrl,
        'outboxBackfill.lockedUntil': lockUntil,
        'outboxBackfill.lastRunAt': now,
      },
      $unset: {
        'outboxBackfill.lastError': '',
      },
    };

    if (outboxChanged) {
      Object.assign(claimUpdate.$set, {
        'outboxBackfill.cursorItemOffset': 0,
        'outboxBackfill.processedCount': 0,
        'outboxBackfill.importedCount': 0,
        'outboxBackfill.existingCount': 0,
        'outboxBackfill.pageCount': 0,
      });
      Object.assign(claimUpdate.$unset, {
        'outboxBackfill.cursorUrl': '',
        'outboxBackfill.completedAt': '',
      });
    }

    const claim = await FederatedActor.updateOne(
      {
        _id: actor._id,
        $or: [
          { 'outboxBackfill.lockedUntil': { $exists: false } },
          { 'outboxBackfill.lockedUntil': null },
          { 'outboxBackfill.lockedUntil': { $lte: now } },
        ],
      },
      claimUpdate,
    );

    if ((claim.modifiedCount ?? 0) === 0) return;

    const remaining = Math.max(0, OUTBOX_RECENT_BACKFILL_LIMIT - previousProcessedCount);
    const result = await federationService.syncOutboxPostsDetailed(
      {
        uri: actor.uri,
        acct: actor.acct,
        outboxUrl,
        oxyUserId: actor.oxyUserId,
      },
      {
        limit: Math.min(OUTBOX_RECENT_BACKFILL_BATCH_SIZE, remaining),
        maxPages: OUTBOX_RECENT_BACKFILL_MAX_PAGES_PER_RUN,
        startPageUrl: outboxChanged ? undefined : previousState?.cursorUrl,
        startItemOffset: outboxChanged ? 0 : previousState?.cursorItemOffset ?? 0,
      },
    );

    const processedDelta = result.candidateCount ?? 0;
    const processedCount = Math.min(OUTBOX_RECENT_BACKFILL_LIMIT, previousProcessedCount + processedDelta);
    const importedCount = previousImportedCount + (result.newPostCount ?? 0) + (result.importedBoostCount ?? 0);
    const existingCount = previousExistingCount + (result.existingCount ?? 0);
    const pageCount = previousPageCount + (result.pagesFetched ?? 0);

    const update: {
      $set: Record<string, unknown>;
      $unset: Record<string, ''>;
    } = {
      $set: {
        'outboxBackfill.outboxUrl': outboxUrl,
        'outboxBackfill.processedCount': processedCount,
        'outboxBackfill.importedCount': importedCount,
        'outboxBackfill.existingCount': existingCount,
        'outboxBackfill.pageCount': pageCount,
        'outboxBackfill.lastRunAt': new Date(),
      },
      $unset: {
        'outboxBackfill.lockedUntil': '',
        'outboxBackfill.lastError': '',
      },
    };

    const permanentlyUnavailable = result.reason === 'non-empty-outbox-without-items'
      || result.reason === 'outbox-http-404'
      || result.reason === 'outbox-http-410';

    if (permanentlyUnavailable) {
      Object.assign(update.$set, {
        'outboxBackfill.status': 'unavailable',
        'outboxBackfill.completedAt': new Date(),
      });
      Object.assign(update.$unset, {
        'outboxBackfill.cursorUrl': '',
      });
    } else if (!result.shouldStampCooldown) {
      Object.assign(update.$set, {
        'outboxBackfill.status': 'failed',
        'outboxBackfill.lastError': result.reason ?? 'unknown',
      });
      delete update.$unset['outboxBackfill.lastError'];
    } else if (processedCount >= OUTBOX_RECENT_BACKFILL_LIMIT || result.reachedEnd || !result.nextCursor) {
      Object.assign(update.$set, {
        'outboxBackfill.status': 'complete',
        'outboxBackfill.completedAt': new Date(),
      });
      Object.assign(update.$unset, {
        'outboxBackfill.cursorUrl': '',
      });
    } else {
      Object.assign(update.$set, {
        'outboxBackfill.status': 'pending',
        'outboxBackfill.cursorUrl': result.nextCursor.url,
        'outboxBackfill.cursorItemOffset': result.nextCursor.itemOffset,
      });
      Object.assign(update.$unset, {
        'outboxBackfill.completedAt': '',
      });
    }

    await FederatedActor.updateOne({ _id: actor._id }, update);
    logger.info(
      `[FedSync] recent backfill ${actor.acct}: status=${String(update.$set['outboxBackfill.status'])} ` +
      `processed=${processedCount}/${OUTBOX_RECENT_BACKFILL_LIMIT} imported=${importedCount} existing=${existingCount}`,
    );
  }

  /**
   * One-time backfill: set oxyUserId on federated posts that were stored without one.
   * Uses bulk operations to avoid N+1 queries.
   */
  private async backfillFederatedPostOxyUserIds(): Promise<void> {
    if (this.isBackfillFederatedPostOxyUserIdsRunning) {
      logger.debug('[FedSync] backfillFederatedPostOxyUserIds already running, skipping');
      return;
    }
    this.isBackfillFederatedPostOxyUserIdsRunning = true;
    try {
      const posts = await Post.find({
        federation: { $ne: null },
        $or: [{ oxyUserId: null }, { oxyUserId: { $exists: false } }],
      })
        .select('federation')
        .limit(500)
        .lean();

      if (posts.length === 0) return;

      logger.info(`[FedSync] Backfilling oxyUserId for ${posts.length} federated posts`);

      // Derive actor URIs from activity IDs using the shared utility
      const postActorMap = new Map<string, string[]>(); // actorUri → [postId, ...]

      for (const post of posts) {
        const activityId = (post.federation as { activityId?: string } | undefined)?.activityId;
        if (!activityId) continue;

        const actorUri = extractActorUriFromActivityId(activityId);
        if (!actorUri) {
          logger.debug(`[FedSync] Backfill: could not extract actor URI from ${activityId}`);
          continue;
        }

        const postIds = postActorMap.get(actorUri) ?? [];
        postIds.push(String(post._id));
        postActorMap.set(actorUri, postIds);
      }

      if (postActorMap.size === 0) return;

      // Single batch query for all actor URIs
      const actors = await FederatedActor.find({
        uri: { $in: [...postActorMap.keys()] },
        oxyUserId: { $ne: null },
      })
        .select('uri oxyUserId')
        .lean();

      // Build bulk updates grouped by oxyUserId
      const bulkOps: Array<{ updateMany: { filter: Record<string, unknown>; update: Record<string, unknown> } }> = [];
      for (const actor of actors) {
        const postIds = postActorMap.get(actor.uri);
        if (!postIds?.length || !actor.oxyUserId) continue;
        bulkOps.push({
          updateMany: {
            filter: { _id: { $in: postIds } },
            update: { $set: { oxyUserId: actor.oxyUserId } },
          },
        });
      }

      if (bulkOps.length === 0) return;

      const result = await Post.bulkWrite(bulkOps, { ordered: false });
      logger.info(`[FedSync] Backfill complete: updated ${result.modifiedCount}/${posts.length} posts`);
    } finally {
      this.isBackfillFederatedPostOxyUserIdsRunning = false;
    }
  }

  /**
   * Retry pending deliveries whose nextAttemptAt has passed.
   */
  private async retryFailedDeliveries(): Promise<void> {
    if (this.isRetryFailedDeliveriesRunning) {
      logger.debug('retryFailedDeliveries already running, skipping');
      return;
    }
    this.isRetryFailedDeliveriesRunning = true;
    try {
      const now = new Date();

      const pending = await FederationDeliveryQueue.find({
        status: 'pending',
        nextAttemptAt: { $lte: now },
      })
        .limit(200) // Process in larger batches to avoid backlog
        .sort({ nextAttemptAt: 1 })
        .lean();

      if (pending.length === 0) return;

      logger.debug(`Retrying ${pending.length} pending deliveries`);

      for (const delivery of pending) {
        try {
          // Need the sender's username to sign the request
          const { oxy } = require('../../server.js');
          const user = await oxy.getUserById(delivery.senderOxyUserId);
          if (!user?.username) {
            await FederationDeliveryQueue.updateOne(
              { _id: delivery._id },
              { $set: { status: 'failed', error: 'Sender user not found' } },
            );
            continue;
          }

          const success = await federationService.deliverActivity(
            delivery.activityJson as Record<string, unknown>,
            delivery.targetInbox,
            delivery.senderOxyUserId,
            user.username,
          );

          if (success) {
            await FederationDeliveryQueue.updateOne(
              { _id: delivery._id },
              { $set: { status: 'delivered', lastAttemptAt: now, error: undefined } },
            );
          } else {
            const nextAttempt = getNextRetryTime(delivery.attempts + 1);
            if (!nextAttempt) {
              await FederationDeliveryQueue.updateOne(
                { _id: delivery._id },
                { $set: { status: 'failed', lastAttemptAt: now, error: 'Max retries exceeded' } },
              );
            } else {
              await FederationDeliveryQueue.updateOne(
                { _id: delivery._id },
                {
                  $set: { lastAttemptAt: now, nextAttemptAt: nextAttempt },
                  $inc: { attempts: 1 },
                },
              );
            }
          }
        } catch (err) {
          logger.debug(`Delivery retry failed for ${delivery._id}:`, err);
          await FederationDeliveryQueue.updateOne(
            { _id: delivery._id },
            {
              $set: {
                lastAttemptAt: now,
                error: err instanceof Error ? err.message : String(err),
              },
              $inc: { attempts: 1 },
            },
          );
        }
      }
    } finally {
      this.isRetryFailedDeliveriesRunning = false;
    }
  }

  /**
   * Drain pending federated-media cache jobs. No-ops when the cache write side
   * is disabled (Oxy service-client upload capability is blocked upstream).
   */
  private async runMediaCacheWorker(): Promise<void> {
    if (this.isMediaCacheWorkerRunning) {
      logger.debug('[MediaCache] worker already running, skipping');
      return;
    }
    this.isMediaCacheWorkerRunning = true;
    try {
      await runCacheWorkerOnce();
    } finally {
      this.isMediaCacheWorkerRunning = false;
    }
  }

  /**
   * Evict idle cached media from Oxy S3 past the activity TTL. No-ops when the
   * cache write side is disabled (Oxy service-client delete is blocked upstream).
   */
  private async runMediaCacheEviction(): Promise<void> {
    if (this.isMediaCacheEvictionRunning) {
      logger.debug('[MediaCache] eviction already running, skipping');
      return;
    }
    this.isMediaCacheEvictionRunning = true;
    try {
      await runEvictionOnce();
    } finally {
      this.isMediaCacheEvictionRunning = false;
    }
  }

}

export const federationJobScheduler = new FederationJobScheduler();
export default federationJobScheduler;
