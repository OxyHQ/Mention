import { logger } from '../utils/logger';
import { FEDERATION_ENABLED } from '../connectors/activitypub/constants';
import {
  claimOutboxBackfill,
  findActorsWithOutboxByUris,
  findOutboxBackfillCandidates,
  findStaleActorsForRefresh,
  updateOutboxBackfill,
  type OutboxBackfillCandidate,
  type OutboxBackfillPatch,
} from '../db/federation/actorRepository';
import { distinctRemoteActorUris } from '../db/federation/followRepository';
import {
  findDueDeliveries,
  findUnmigratedDeliveries,
  getNextRetryTime,
  markDeliveriesMigrated,
  recordDeliveryAttempt,
} from '../db/federation/deliveryQueueRepository';
import { activityPubConnector, isPermanentlyUnavailableOutboxReason } from '../connectors/activitypub/ActivityPubConnector';
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
  PERIODIC_MEDIA_CACHE_WORKER,
  PERIODIC_MEDIA_CACHE_EVICTION,
  PERIODIC_COMPUTE_INTEREST_SCORES,
  PERIODIC_FLUSH_ENDORSEMENT_OUTBOX,
  PERIODIC_FLUSH_AFFINITY_EVENTS,
  REFRESH_STALE_ACTORS_INTERVAL_MS,
  SYNC_FOLLOWED_OUTBOX_INTERVAL_MS,
  RECENT_OUTBOX_BACKFILL_INTERVAL_MS,
  COMPUTE_INTEREST_SCORES_INTERVAL_MS,
  FLUSH_ENDORSEMENT_OUTBOX_INTERVAL_MS,
  FLUSH_AFFINITY_EVENTS_INTERVAL_MS,
  DELIVERY_DRAIN_PAGE_SIZE,
} from '../queue/constants';
import type { PeriodicTaskName } from '../queue/types';
import { interestScoreService } from './InterestScoreService';
import { endorsementSignalService } from './EndorsementSignalService';
import { affinityEventService } from './AffinityEventService';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import type { User } from '@oxyhq/core';

/** Staleness threshold after which an actor profile is re-fetched. */
const ACTOR_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Legacy (no-Redis) Mongo delivery-retry loop cadence. */
const DELIVERY_RETRY_INTERVAL_MS = 60 * 1000; // 1 minute

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

class FederationJobScheduler {
  private actorRefreshInterval: ReturnType<typeof setInterval> | null = null;
  private deliveryRetryInterval: ReturnType<typeof setInterval> | null = null;
  private outboxSyncInterval: ReturnType<typeof setInterval> | null = null;
  private outboxBackfillInterval: ReturnType<typeof setInterval> | null = null;
  private mediaCacheWorkerInterval: ReturnType<typeof setInterval> | null = null;
  private mediaCacheEvictionInterval: ReturnType<typeof setInterval> | null = null;
  private interestScoresInterval: ReturnType<typeof setInterval> | null = null;
  private endorsementOutboxInterval: ReturnType<typeof setInterval> | null = null;
  private affinityEventsInterval: ReturnType<typeof setInterval> | null = null;

  // Startup delay timeout handles (cleared in stop())
  private initialSyncTimeout: ReturnType<typeof setTimeout> | null = null;

  // Overlap guards — prevent concurrent runs when intervals fire faster than jobs complete
  private isSyncFollowedActorsPostsRunning = false;
  private isSyncRecentOutboxBackfillsRunning = false;
  private isRetryFailedDeliveriesRunning = false;
  private isMediaCacheWorkerRunning = false;
  private isMediaCacheEvictionRunning = false;
  private isComputeInterestScoresRunning = false;
  private isFlushEndorsementOutboxRunning = false;
  private isFlushAffinityEventsRunning = false;

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
    this.actorRefreshInterval.unref?.();

    // Retry failed deliveries every minute (Mongo delivery queue)
    this.deliveryRetryInterval = setInterval(() => {
      this.retryFailedDeliveries().catch((err) =>
        logger.error('Delivery retry job failed:', err)
      );
    }, DELIVERY_RETRY_INTERVAL_MS);
    this.deliveryRetryInterval.unref?.();

    this.outboxSyncInterval = setInterval(() => {
      this.syncFollowedActorsPosts().catch((err) =>
        logger.error('Outbox sync job failed:', err)
      );
    }, SYNC_FOLLOWED_OUTBOX_INTERVAL_MS);
    this.outboxSyncInterval.unref?.();

    this.outboxBackfillInterval = setInterval(() => {
      this.syncRecentOutboxBackfills().catch((err) =>
        logger.error('Recent outbox backfill job failed:', err)
      );
    }, RECENT_OUTBOX_BACKFILL_INTERVAL_MS);
    this.outboxBackfillInterval.unref?.();

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
      this.mediaCacheWorkerInterval.unref?.();

      // Evict idle cached media from Oxy S3 (activity-based TTL).
      this.mediaCacheEvictionInterval = setInterval(() => {
        this.runMediaCacheEviction().catch((err) =>
          logger.error('Media cache eviction job failed:', err)
        );
      }, MEDIA_CACHE_EVICTION_INTERVAL_MS);
      this.mediaCacheEvictionInterval.unref?.();

    }

    // Recommendation-signal jobs (interest-score recompute + endorsement-outbox
    // drain). Always armed — they are not gated on the media cache.
    this.interestScoresInterval = setInterval(() => {
      this.computeInterestScores().catch((err) =>
        logger.error('Interest score recompute job failed:', err)
      );
    }, COMPUTE_INTEREST_SCORES_INTERVAL_MS);
    this.interestScoresInterval.unref?.();

    this.endorsementOutboxInterval = setInterval(() => {
      this.flushEndorsementOutbox().catch((err) =>
        logger.error('Endorsement outbox flush job failed:', err)
      );
    }, FLUSH_ENDORSEMENT_OUTBOX_INTERVAL_MS);
    this.endorsementOutboxInterval.unref?.();

    this.affinityEventsInterval = setInterval(() => {
      this.flushAffinityEvents().catch((err) =>
        logger.error('Affinity events flush job failed:', err)
      );
    }, FLUSH_AFFINITY_EVENTS_INTERVAL_MS);
    this.affinityEventsInterval.unref?.();

    // Stagger startup tasks to let DB connections warm up
    this.initialSyncTimeout = setTimeout(() => {
      this.syncFollowedActorsPosts().catch((err) =>
        logger.error('Initial outbox sync failed:', err)
      );
      this.syncRecentOutboxBackfills().catch((err) =>
        logger.error('Initial recent outbox backfill failed:', err)
      );
    }, INITIAL_SYNC_STARTUP_DELAY_MS);
    this.initialSyncTimeout.unref?.();
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
    await upsert(PERIODIC_COMPUTE_INTEREST_SCORES, COMPUTE_INTEREST_SCORES_INTERVAL_MS, 'computeInterestScores');
    await upsert(PERIODIC_FLUSH_ENDORSEMENT_OUTBOX, FLUSH_ENDORSEMENT_OUTBOX_INTERVAL_MS, 'flushEndorsementOutbox');
    await upsert(PERIODIC_FLUSH_AFFINITY_EVENTS, FLUSH_AFFINITY_EVENTS_INTERVAL_MS, 'flushAffinityEvents');

    if (isMediaCacheEnabled()) {
      await upsert(PERIODIC_MEDIA_CACHE_WORKER, MEDIA_CACHE_WORKER_INTERVAL_MS, 'runMediaCacheWorker');
      await upsert(PERIODIC_MEDIA_CACHE_EVICTION, MEDIA_CACHE_EVICTION_INTERVAL_MS, 'runMediaCacheEviction');
    }

    logger.info('Federation repeatable jobs registered');
  }

  /**
   * Drain any `federation_delivery_queue` rows left in `pending` (written by an
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
      const rows = await findUnmigratedDeliveries(DELIVERY_DRAIN_PAGE_SIZE);

      if (rows.length === 0) break;

      const migratedIds: string[] = [];
      for (const row of rows) {
        const jobId = `delivery:migrated:${row.id}`;
        const enqueued = await enqueueDeliveryWithJobId(
          {
            activityJson: row.activityJson,
            targetInbox: row.targetInbox,
            senderOxyUserId: row.senderOxyUserId,
          },
          jobId,
        ).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn('[FedDeliver] drain enqueue failed', {
            error: message,
          });
          return false;
        });

        if (enqueued) {
          migratedIds.push(row.id);
        }
      }

      if (migratedIds.length > 0) {
        await markDeliveriesMigrated(migratedIds);
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
    if (this.affinityEventsInterval) {
      clearInterval(this.affinityEventsInterval);
      this.affinityEventsInterval = null;
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
      PERIODIC_MEDIA_CACHE_WORKER,
      PERIODIC_MEDIA_CACHE_EVICTION,
      PERIODIC_COMPUTE_INTEREST_SCORES,
      PERIODIC_FLUSH_ENDORSEMENT_OUTBOX,
      PERIODIC_FLUSH_AFFINITY_EVENTS,
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
    const followedUris = await distinctRemoteActorUris({ statuses: ['accepted'] });

    // Refresh anything that is stale AND either followed or has been resolved
    // locally (oxyUserId set ⇒ a Mention user can view this profile). This keeps
    // viewed-but-not-followed profiles fresh too. Batched to avoid fan-out storms.
    const staleActors = await findStaleActorsForRefresh(
      staleThreshold,
      followedUris,
      ACTOR_REFRESH_BATCH_SIZE,
    );

    if (staleActors.length === 0) return;

    logger.info(`[FedSync] Refreshing ${staleActors.length} stale actor profiles (forcing avatar refresh)`);

    // Bounded concurrency to avoid overwhelming remote servers.
    const CONCURRENCY = 3;
    for (let i = 0; i < staleActors.length; i += CONCURRENCY) {
      const batch = staleActors.slice(i, i + CONCURRENCY);
      await Promise.allSettled(
        batch.map((actor) =>
          // forceAvatarRefresh=true → Oxy re-downloads/replaces the avatar.
          activityPubConnector.fetchRemoteActor(actor.uri, true, actor.acct).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            logger.debug('[FedSync] failed to refresh actor', {
              error: message,
            });
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
      const followedActorUris = await distinctRemoteActorUris({
        direction: 'outbound',
        statuses: ['accepted'],
      });

      if (followedActorUris.length === 0) return;

      // `{ outboxUrl: { $ne: null } }` becomes `outbox_url IS NOT NULL` — the
      // total predicate. `<> null` would be NULL for every row and select none.
      const actors = await findActorsWithOutboxByUris(followedActorUris);

      if (actors.length === 0) return;

      logger.info(`[FedSync] Syncing outbox posts for ${actors.length} followed actors`);

      // Bounded concurrency to avoid overwhelming remote servers
      const CONCURRENCY = 3;
      for (let i = 0; i < actors.length; i += CONCURRENCY) {
        const batch = actors.slice(i, i + CONCURRENCY);
        await Promise.allSettled(
          batch.map((actor) =>
            activityPubConnector.syncOutboxPosts(actor, 20).catch((err) =>
              logger.debug('[FedSync] outbox sync failed', err)
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
      const actors = await findOutboxBackfillCandidates(
        now,
        OUTBOX_RECENT_BACKFILL_ACTOR_BATCH_SIZE,
      );

      if (actors.length === 0) return;

      logger.info(`[FedSync] Advancing recent outbox backfill for ${actors.length} actors`);

      for (const actor of actors) {
        await this.runRecentOutboxBackfillForActor(actor);
      }
    } finally {
      this.isSyncRecentOutboxBackfillsRunning = false;
    }
  }

  private async runRecentOutboxBackfillForActor(actor: OutboxBackfillCandidate): Promise<void> {
    const outboxUrl = actor.outboxUrl;
    if (!outboxUrl) return;

    const previousState = actor.outboxBackfill;
    const outboxChanged = Boolean(previousState?.outboxUrl && previousState.outboxUrl !== outboxUrl);
    const previousProcessedCount = outboxChanged ? 0 : Math.max(0, previousState?.processedCount ?? 0);
    const previousImportedCount = outboxChanged ? 0 : Math.max(0, previousState?.importedCount ?? 0);
    const previousExistingCount = outboxChanged ? 0 : Math.max(0, previousState?.existingCount ?? 0);
    const previousPageCount = outboxChanged ? 0 : Math.max(0, previousState?.pageCount ?? 0);

    if (!outboxChanged && previousProcessedCount >= OUTBOX_RECENT_BACKFILL_LIMIT) {
      await updateOutboxBackfill(actor.id, {
        status: 'complete',
        outboxUrl,
        processedCount: OUTBOX_RECENT_BACKFILL_LIMIT,
        completedAt: new Date(),
        cursorUrl: null,
        lockedUntil: null,
        lastError: null,
      });
      return;
    }

    const now = new Date();
    const lockUntil = new Date(now.getTime() + OUTBOX_RECENT_BACKFILL_LOCK_MS);
    const claimPatch: OutboxBackfillPatch = {
      status: 'pending',
      outboxUrl,
      lockedUntil: lockUntil,
      lastRunAt: now,
      lastError: null,
    };

    // The remote MOVED its outbox: the stored counters describe a collection
    // that no longer exists, so the whole cursor is reset rather than resumed.
    if (outboxChanged) {
      claimPatch.cursorItemOffset = 0;
      claimPatch.processedCount = 0;
      claimPatch.importedCount = 0;
      claimPatch.existingCount = 0;
      claimPatch.pageCount = 0;
      claimPatch.cursorUrl = null;
      claimPatch.completedAt = null;
    }

    // Re-tests the lock inside the UPDATE, so two schedulers that selected the
    // same actor cannot both proceed.
    const claimed = await claimOutboxBackfill(actor.id, now, claimPatch);
    if (!claimed) return;

    const remaining = Math.max(0, OUTBOX_RECENT_BACKFILL_LIMIT - previousProcessedCount);
    const result = await activityPubConnector.syncOutboxPostsDetailed(
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

    // The lease is released and the error cleared in every branch; the failure
    // branch then re-sets `lastError`, which is why it is written LAST rather
    // than conditionally omitted from the base patch.
    const patch: OutboxBackfillPatch = {
      outboxUrl,
      processedCount,
      importedCount,
      existingCount,
      pageCount,
      lastRunAt: new Date(),
      lockedUntil: null,
      lastError: null,
    };

    if (isPermanentlyUnavailableOutboxReason(result.reason)) {
      patch.status = 'unavailable';
      patch.completedAt = new Date();
      patch.cursorUrl = null;
    } else if (!result.shouldStampCooldown) {
      patch.status = 'failed';
      patch.lastError = result.reason ?? 'unknown';
    } else if (processedCount >= OUTBOX_RECENT_BACKFILL_LIMIT || result.reachedEnd || !result.nextCursor) {
      patch.status = 'complete';
      patch.completedAt = new Date();
      patch.cursorUrl = null;
    } else {
      patch.status = 'pending';
      patch.cursorUrl = result.nextCursor.url;
      patch.cursorItemOffset = result.nextCursor.itemOffset;
      patch.completedAt = null;
    }

    await updateOutboxBackfill(actor.id, patch);
    logger.info(
      '[FedSync] recent backfill completed',
      {
        status: String(patch.status),
        processedCount,
        processingLimit: OUTBOX_RECENT_BACKFILL_LIMIT,
        importedCount,
        existingCount,
      },
    );
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

      // Larger batches to avoid backlog.
      const pending = await findDueDeliveries(now, 200);

      if (pending.length === 0) return;

      logger.debug(`Retrying ${pending.length} pending deliveries`);

      // Resolve every distinct sender in ONE batched round-trip rather than a
      // per-delivery getUserById (up to 200 deliveries, with duplicate senders
      // re-fetched). Uses the service-authed Oxy client — the process-wide
      // request-auth client is unauthenticated and is reserved for
      // validating INCOMING request tokens (`oxy.auth()`), so a bulk resolve on
      // it returns nothing.
      const uniqueSenderIds = [...new Set(pending.map((d) => d.senderOxyUserId))];
      const senders = new Map<string, User>();
      try {
        const resolved = await getServiceOxyClient().getUsersByIds(uniqueSenderIds);
        for (const sender of resolved) {
          if (sender?.id) senders.set(sender.id, sender);
        }
      } catch (err) {
        logger.warn('[FedSync] Failed to batch-resolve delivery senders:', err);
      }

      for (const delivery of pending) {
        try {
          // Need the sender's username to sign the request.
          const user = senders.get(delivery.senderOxyUserId);
          if (!user?.username) {
            await recordDeliveryAttempt(delivery.id, {
              status: 'failed',
              error: 'Sender user not found',
            });
            continue;
          }

          const success = await activityPubConnector.deliverActivity(
            delivery.activityJson,
            delivery.targetInbox,
            delivery.senderOxyUserId,
            user.username,
          );

          if (success) {
            // `error` is deliberately not cleared. The Mongo write said
            // `error: undefined`, which Mongoose STRIPS from a `$set`, so a
            // delivered row has always kept whatever a prior failed attempt
            // left there. Clearing it here would be a behaviour change.
            await recordDeliveryAttempt(delivery.id, {
              status: 'delivered',
              lastAttemptAt: now,
            });
          } else {
            const nextAttempt = getNextRetryTime(delivery.attempts + 1);
            if (!nextAttempt) {
              await recordDeliveryAttempt(delivery.id, {
                status: 'failed',
                lastAttemptAt: now,
                error: 'Max retries exceeded',
              });
            } else {
              await recordDeliveryAttempt(delivery.id, {
                lastAttemptAt: now,
                nextAttemptAt: nextAttempt,
                incrementAttempts: true,
              });
            }
          }
        } catch (err) {
          logger.debug('Delivery retry failed', err);
          await recordDeliveryAttempt(delivery.id, {
            lastAttemptAt: now,
            error: err instanceof Error ? err.message : String(err),
            incrementAttempts: true,
          });
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

  /**
   * Drain the buffered interaction-affinity events (Redis list) and push a batch
   * to Oxy's recommendation affinity graph. No-ops when Redis is unavailable or
   * the buffer is empty. Best-effort — a push failure re-buffers a bounded
   * amount inside the service and the next tick retries.
   *
   * Public so the BullMQ periodic worker can invoke it; also called by the
   * legacy in-process interval path.
   */
  async flushAffinityEvents(): Promise<void> {
    if (this.isFlushAffinityEventsRunning) {
      logger.debug('[AffinityEvent] flush already running, skipping');
      return;
    }
    this.isFlushAffinityEventsRunning = true;
    try {
      await affinityEventService.drainOnce();
    } finally {
      this.isFlushAffinityEventsRunning = false;
    }
  }

}

export const federationJobScheduler = new FederationJobScheduler();
export default federationJobScheduler;
