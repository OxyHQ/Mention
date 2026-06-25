import { logger } from '../utils/logger';
import type { Types } from 'mongoose';
import { FEDERATION_ENABLED } from '../utils/federation/constants';
import FederatedActor, { type FederatedOutboxBackfillState } from '../models/FederatedActor';
import FederatedFollow from '../models/FederatedFollow';
import FederationDeliveryQueue, { getNextRetryTime } from '../models/FederationDeliveryQueue';
import { Post } from '../models/Post';
import { federationService, isPermanentlyUnavailableOutboxReason } from './FederationService';
import { runCacheWorkerOnce } from './mediaCache/cacheWorker';
import { runEvictionOnce } from './mediaCache/evictionJob';
import { isMediaCacheEnabled } from './mediaCache/oxyMediaStore';
import {
  MEDIA_CACHE_EVICTION_INTERVAL_MS,
  MEDIA_CACHE_WORKER_INTERVAL_MS,
} from './mediaCache/constants';
import { isQueueEnabled } from '../queue/connection';
import { getPeriodicQueue } from '../queue/queues';
import { enqueueDeliveryWithJobId } from '../queue/producers';
import {
  PERIODIC_REFRESH_STALE_ACTORS,
  PERIODIC_SYNC_FOLLOWED_OUTBOX,
  PERIODIC_RECENT_OUTBOX_BACKFILL,
  PERIODIC_BACKFILL_OXY_USER_IDS,
  PERIODIC_MEDIA_CACHE_WORKER,
  PERIODIC_MEDIA_CACHE_EVICTION,
  PERIODIC_COMPUTE_INTEREST_SCORES,
  PERIODIC_FLUSH_ENDORSEMENT_OUTBOX,
  REFRESH_STALE_ACTORS_INTERVAL_MS,
  SYNC_FOLLOWED_OUTBOX_INTERVAL_MS,
  RECENT_OUTBOX_BACKFILL_INTERVAL_MS,
  BACKFILL_OXY_USER_IDS_INTERVAL_MS,
  COMPUTE_INTEREST_SCORES_INTERVAL_MS,
  FLUSH_ENDORSEMENT_OUTBOX_INTERVAL_MS,
  DELIVERY_DRAIN_PAGE_SIZE,
} from '../queue/constants';
import type { PeriodicTaskName } from '../queue/types';
import { interestScoreService } from './InterestScoreService';
import { endorsementSignalService } from './EndorsementSignalService';
import { oxy } from '../../server';

/** Staleness threshold after which an actor profile is re-fetched. */
const ACTOR_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Legacy (no-Redis) Mongo delivery-retry loop cadence. */
const DELIVERY_RETRY_INTERVAL_MS = 60 * 1000; // 1 minute

/** Legacy startup delay before the one-shot oxyUserId backfill runs. */
const BACKFILL_STARTUP_DELAY_MS = 10 * 1000; // 10 seconds

/** Legacy startup delay before the initial outbox sync + recent backfill run. */
const INITIAL_SYNC_STARTUP_DELAY_MS = 30 * 1000; // 30 seconds

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
  private interestScoresInterval: ReturnType<typeof setInterval> | null = null;
  private endorsementOutboxInterval: ReturnType<typeof setInterval> | null = null;

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
  private isComputeInterestScoresRunning = false;
  private isFlushEndorsementOutboxRunning = false;

  /** True when this scheduler registered BullMQ repeatable jobs (queue mode). */
  private usingQueue = false;

  start(): void {
    if (!FEDERATION_ENABLED) {
      logger.info('Federation disabled — job scheduler not started');
      return;
    }

    // Invoked ONLY by the elected scheduler leader (via leaderElection →
    // startSchedulers). Two transports:
    //  - Queue mode (Redis configured): register BullMQ repeatable jobs so each
    //    periodic task runs once across the fleet, and drain any in-flight Mongo
    //    deliveries into the BullMQ delivery queue. Delivery RETRIES are owned by
    //    BullMQ, so there is no in-process delivery-retry interval here.
    //  - Legacy mode (no Redis): keep the in-process setInterval scheduler and
    //    the Mongo delivery-retry loop. This is the local-dev / degraded path.
    if (isQueueEnabled()) {
      this.usingQueue = true;
      void this.registerRepeatableJobs().catch((err) =>
        logger.error('Failed to register federation repeatable jobs:', err),
      );
      void this.drainPendingMongoDeliveries().catch((err) =>
        logger.error('Failed to drain pending Mongo deliveries into BullMQ:', err),
      );
      logger.info('Federation job scheduler started (BullMQ queue mode)');
      return;
    }

    this.usingQueue = false;
    this.startLegacyIntervals();
    logger.info('Federation job scheduler started (in-process interval mode)');
  }

  /**
   * Legacy in-process scheduler. Used only when Redis/BullMQ is not configured
   * (local dev or a degraded boot). Cadences are unchanged from the original
   * implementation, now sourced from named constants.
   */
  private startLegacyIntervals(): void {
    // Refresh stale actor profiles every 6 hours
    this.actorRefreshInterval = setInterval(() => {
      this.refreshStaleActors().catch((err) =>
        logger.error('Actor refresh job failed:', err)
      );
    }, REFRESH_STALE_ACTORS_INTERVAL_MS);

    // Retry failed deliveries every minute (Mongo delivery queue)
    this.deliveryRetryInterval = setInterval(() => {
      this.retryFailedDeliveries().catch((err) =>
        logger.error('Delivery retry job failed:', err)
      );
    }, DELIVERY_RETRY_INTERVAL_MS);

    this.outboxSyncInterval = setInterval(() => {
      this.syncFollowedActorsPosts().catch((err) =>
        logger.error('Outbox sync job failed:', err)
      );
    }, SYNC_FOLLOWED_OUTBOX_INTERVAL_MS);

    this.outboxBackfillInterval = setInterval(() => {
      this.syncRecentOutboxBackfills().catch((err) =>
        logger.error('Recent outbox backfill job failed:', err)
      );
    }, RECENT_OUTBOX_BACKFILL_INTERVAL_MS);

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

    // Recommendation-signal jobs (interest-score recompute + endorsement-outbox
    // drain). Always armed — they are not gated on the media cache.
    this.interestScoresInterval = setInterval(() => {
      this.computeInterestScores().catch((err) =>
        logger.error('Interest score recompute job failed:', err)
      );
    }, COMPUTE_INTEREST_SCORES_INTERVAL_MS);

    this.endorsementOutboxInterval = setInterval(() => {
      this.flushEndorsementOutbox().catch((err) =>
        logger.error('Endorsement outbox flush job failed:', err)
      );
    }, FLUSH_ENDORSEMENT_OUTBOX_INTERVAL_MS);

    // Stagger startup tasks to let DB connections warm up
    this.backfillTimeout = setTimeout(() => {
      this.backfillFederatedPostOxyUserIds().catch((err) =>
        logger.error('Backfill federated post oxyUserIds failed:', err)
      );
    }, BACKFILL_STARTUP_DELAY_MS);

    this.initialSyncTimeout = setTimeout(() => {
      this.syncFollowedActorsPosts().catch((err) =>
        logger.error('Initial outbox sync failed:', err)
      );
      this.syncRecentOutboxBackfills().catch((err) =>
        logger.error('Initial recent outbox backfill failed:', err)
      );
    }, INITIAL_SYNC_STARTUP_DELAY_MS);
  }

  /**
   * Register the periodic federation tasks as BullMQ repeatable jobs.
   * `upsertJobScheduler` is idempotent per scheduler id, so re-registering on
   * each leadership acquisition never creates duplicate schedules. The
   * media-cache schedules are only registered when the cache is enabled.
   */
  private async registerRepeatableJobs(): Promise<void> {
    const queue = getPeriodicQueue();
    if (!queue) return;

    const upsert = async (
      schedulerId: string,
      everyMs: number,
      task: PeriodicTaskName,
    ): Promise<void> => {
      await queue.upsertJobScheduler(
        schedulerId,
        { every: everyMs },
        { name: task, data: { task } },
      );
    };

    await upsert(PERIODIC_REFRESH_STALE_ACTORS, REFRESH_STALE_ACTORS_INTERVAL_MS, 'refreshStaleActors');
    await upsert(PERIODIC_SYNC_FOLLOWED_OUTBOX, SYNC_FOLLOWED_OUTBOX_INTERVAL_MS, 'syncFollowedActorsPosts');
    await upsert(PERIODIC_RECENT_OUTBOX_BACKFILL, RECENT_OUTBOX_BACKFILL_INTERVAL_MS, 'syncRecentOutboxBackfills');
    await upsert(PERIODIC_BACKFILL_OXY_USER_IDS, BACKFILL_OXY_USER_IDS_INTERVAL_MS, 'backfillFederatedPostOxyUserIds');
    await upsert(PERIODIC_COMPUTE_INTEREST_SCORES, COMPUTE_INTEREST_SCORES_INTERVAL_MS, 'computeInterestScores');
    await upsert(PERIODIC_FLUSH_ENDORSEMENT_OUTBOX, FLUSH_ENDORSEMENT_OUTBOX_INTERVAL_MS, 'flushEndorsementOutbox');

    if (isMediaCacheEnabled()) {
      await upsert(PERIODIC_MEDIA_CACHE_WORKER, MEDIA_CACHE_WORKER_INTERVAL_MS, 'runMediaCacheWorker');
      await upsert(PERIODIC_MEDIA_CACHE_EVICTION, MEDIA_CACHE_EVICTION_INTERVAL_MS, 'runMediaCacheEviction');
    }

    logger.info('Federation repeatable jobs registered');
  }

  /**
   * Drain any `FederationDeliveryQueue` rows left in `pending` (written by an
   * older build or while the queue was unavailable) into the BullMQ delivery
   * queue, then mark them migrated so a re-run never re-enqueues the same row.
   *
   * Idempotency: each row is enqueued with a STABLE jobId derived from its Mongo
   * `_id`, so even if the process dies between enqueue and mark, re-running the
   * drain maps the same row to the same BullMQ job and BullMQ dedupes it. No
   * pending delivery is dropped.
   */
  private async drainPendingMongoDeliveries(): Promise<void> {
    let totalDrained = 0;

    // Page through pending, not-yet-migrated rows to bound memory.
    for (;;) {
      const rows = await FederationDeliveryQueue.find({
        status: 'pending',
        migratedToBullmq: { $ne: true },
      })
        .sort({ nextAttemptAt: 1 })
        .limit(DELIVERY_DRAIN_PAGE_SIZE)
        .lean();

      if (rows.length === 0) break;

      const migratedIds: Types.ObjectId[] = [];
      for (const row of rows) {
        const jobId = `delivery:migrated:${String(row._id)}`;
        const enqueued = await enqueueDeliveryWithJobId(
          {
            activityJson: row.activityJson as Record<string, unknown>,
            targetInbox: row.targetInbox,
            senderOxyUserId: row.senderOxyUserId,
          },
          jobId,
        ).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`[FedDeliver] drain enqueue failed for ${String(row._id)}: ${message}`);
          return false;
        });

        if (enqueued) {
          migratedIds.push(row._id);
        }
      }

      if (migratedIds.length > 0) {
        await FederationDeliveryQueue.updateMany(
          { _id: { $in: migratedIds } },
          { $set: { migratedToBullmq: true } },
        );
        totalDrained += migratedIds.length;
      }

      // If nothing in this page could be enqueued (queue unavailable), stop to
      // avoid an infinite loop over the same rows.
      if (migratedIds.length === 0) break;

      // Last partial page → done.
      if (rows.length < DELIVERY_DRAIN_PAGE_SIZE) break;
    }

    if (totalDrained > 0) {
      logger.info(`[FedDeliver] drained ${totalDrained} pending Mongo deliveries into BullMQ`);
    }
  }

  stop(): void {
    // Queue mode: remove the repeatable-job schedules so no new periodic jobs
    // are produced after this task steps down. Existing in-flight jobs are owned
    // by BullMQ and finish on whichever worker holds them.
    if (this.usingQueue) {
      this.usingQueue = false;
      void this.removeRepeatableJobs().catch((err) =>
        logger.error('Failed to remove federation repeatable jobs:', err),
      );
      logger.info('Federation job scheduler stopped (BullMQ queue mode)');
      return;
    }

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
    if (this.interestScoresInterval) {
      clearInterval(this.interestScoresInterval);
      this.interestScoresInterval = null;
    }
    if (this.endorsementOutboxInterval) {
      clearInterval(this.endorsementOutboxInterval);
      this.endorsementOutboxInterval = null;
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
   * Remove the BullMQ repeatable-job schedules registered by this leader. Safe
   * to call when a scheduler was never registered (missing ids are ignored).
   */
  private async removeRepeatableJobs(): Promise<void> {
    const queue = getPeriodicQueue();
    if (!queue) return;

    const ids = [
      PERIODIC_REFRESH_STALE_ACTORS,
      PERIODIC_SYNC_FOLLOWED_OUTBOX,
      PERIODIC_RECENT_OUTBOX_BACKFILL,
      PERIODIC_BACKFILL_OXY_USER_IDS,
      PERIODIC_MEDIA_CACHE_WORKER,
      PERIODIC_MEDIA_CACHE_EVICTION,
      PERIODIC_COMPUTE_INTEREST_SCORES,
      PERIODIC_FLUSH_ENDORSEMENT_OUTBOX,
    ];

    await Promise.allSettled(ids.map((id) => queue.removeJobScheduler(id)));
    logger.info('Federation repeatable jobs removed');
  }

  /**
   * Refresh stale (>24h) actor profiles so their avatar/banner/display name stay
   * current. Covers BOTH followed actors AND any federated actor that has been
   * resolved/viewed locally (i.e. has an oxyUserId, meaning a Mention user can
   * land on its profile). The avatar refresh is FORCED so Oxy re-downloads and
   * replaces the federated avatar, and the banner is re-synced as part of the
   * full fetch.
   *
   * Public so the BullMQ periodic worker can invoke it; also called by the
   * legacy in-process interval path.
   */
  async refreshStaleActors(): Promise<void> {
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
   *
   * Public so the BullMQ periodic worker can invoke it.
   */
  async syncFollowedActorsPosts(): Promise<void> {
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
   *
   * Public so the BullMQ periodic worker can invoke it.
   */
  async syncRecentOutboxBackfills(): Promise<void> {
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

    if (isPermanentlyUnavailableOutboxReason(result.reason)) {
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
   * Backfill oxyUserId only when a post already stores a verified ActivityPub
   * actor URI from its original inbox/outbox import. Older posts that only have
   * an activityId are intentionally skipped: activity IDs are attacker-controlled
   * strings and are not proof of authorship.
   *
   * Public so the BullMQ periodic worker can invoke it.
   */
  async backfillFederatedPostOxyUserIds(): Promise<void> {
    if (this.isBackfillFederatedPostOxyUserIdsRunning) {
      logger.debug('[FedSync] backfillFederatedPostOxyUserIds already running, skipping');
      return;
    }
    this.isBackfillFederatedPostOxyUserIdsRunning = true;
    try {
      const posts = await Post.find({
        federation: { $ne: null },
        'federation.actorUri': { $exists: true, $ne: null },
        $or: [{ oxyUserId: null }, { oxyUserId: { $exists: false } }],
      })
        .select('federation.actorUri')
        .limit(500)
        .lean();

      if (posts.length === 0) return;

      logger.info(`[FedSync] Backfilling oxyUserId for ${posts.length} federated posts with verified actor URIs`);

      const postActorMap = new Map<string, string[]>();
      for (const post of posts) {
        const actorUri = (post.federation as { actorUri?: string } | undefined)?.actorUri;
        if (!actorUri) continue;
        const postIds = postActorMap.get(actorUri) ?? [];
        postIds.push(String(post._id));
        postActorMap.set(actorUri, postIds);
      }

      if (postActorMap.size === 0) return;

      const actors = await FederatedActor.find({
        uri: { $in: [...postActorMap.keys()] },
        oxyUserId: { $ne: null },
      })
        .select('uri oxyUserId')
        .lean();

      const bulkOps: Array<{ updateMany: { filter: Record<string, unknown>; update: Record<string, unknown> } }> = [];
      for (const actor of actors) {
        const postIds = postActorMap.get(actor.uri);
        if (!postIds?.length || !actor.oxyUserId) continue;
        bulkOps.push({
          updateMany: {
            filter: { _id: { $in: postIds }, 'federation.actorUri': actor.uri },
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
          // Need the sender's username to sign the request. `oxy` is the
          // service OxyServices singleton exported from server.ts. This module
          // is only loaded via `require('./src/services/FederationJobScheduler')`
          // at server bootstrap (after `oxy` and the services are constructed),
          // so the static import binding is always live by the time a retry runs
          // — same rationale as the delivery worker in queue/workers.ts.
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
   *
   * Public so the BullMQ periodic worker can invoke it.
   */
  async runMediaCacheWorker(): Promise<void> {
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
   *
   * Public so the BullMQ periodic worker can invoke it.
   */
  async runMediaCacheEviction(): Promise<void> {
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

  /**
   * Recompute per-author interest scores from recent engagement and push the
   * deltas to Oxy's recommendation graph. No-ops when there is nothing to score.
   *
   * Public so the BullMQ periodic worker can invoke it; also called by the
   * legacy in-process interval path.
   */
  async computeInterestScores(): Promise<void> {
    if (this.isComputeInterestScoresRunning) {
      logger.debug('[InterestScore] recompute already running, skipping');
      return;
    }
    this.isComputeInterestScoresRunning = true;
    try {
      await interestScoreService.run();
    } finally {
      this.isComputeInterestScoresRunning = false;
    }
  }

  /**
   * Drain pending endorsement-outbox rows (re-syncing each scope's current
   * member set to Oxy). The safety net for membership pushes that failed their
   * immediate attempt. No-ops when the outbox is empty.
   *
   * Public so the BullMQ periodic worker can invoke it; also called by the
   * legacy in-process interval path.
   */
  async flushEndorsementOutbox(): Promise<void> {
    if (this.isFlushEndorsementOutboxRunning) {
      logger.debug('[EndorsementSignal] flush already running, skipping');
      return;
    }
    this.isFlushEndorsementOutboxRunning = true;
    try {
      await endorsementSignalService.flushOutbox();
    } finally {
      this.isFlushEndorsementOutboxRunning = false;
    }
  }

}

export const federationJobScheduler = new FederationJobScheduler();
export default federationJobScheduler;
