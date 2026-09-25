import { Worker, type Job, UnrecoverableError } from 'bullmq';
import { getQueueConnection, isQueueEnabled, closeQueueConnection } from './connection';
import { closeQueues } from './queues';
import {
  FEDERATION_INBOX_QUEUE,
  FEDERATION_DELIVERY_QUEUE,
  FEDERATION_PERIODIC_QUEUE,
  FEDERATION_SHARING_CLEANUP_QUEUE,
  MEDIA_METADATA_ENRICH_QUEUE,
  ACCOUNT_ERASURE_QUEUE,
  ACCOUNT_ERASURE_WORKER_CONCURRENCY,
  INBOX_WORKER_CONCURRENCY,
  DELIVERY_WORKER_CONCURRENCY,
  PERIODIC_WORKER_CONCURRENCY,
  SHARING_CLEANUP_WORKER_CONCURRENCY,
  MEDIA_METADATA_ENRICH_WORKER_CONCURRENCY,
  DELIVERY_BACKOFF_INTERVALS_MS,
  DELIVERY_BACKOFF_STRATEGY,
} from './constants';
import type {
  InboxJobData,
  DeliveryJobData,
  PeriodicJobData,
  PeriodicTaskName,
  SharingCleanupJobData,
  MediaMetadataEnrichJobData,
  AccountErasureJobData,
} from './types';
import { logger } from '../utils/logger';
import { activityPubConnector } from '../connectors/activitypub/ActivityPubConnector';
import { federationJobScheduler } from '../services/FederationJobScheduler';
import { runSharingCleanup } from '../connectors/activitypub/sharingCleanup.service';
import { processMediaMetadataEnrichJob } from '../services/mediaMetadataEnrichJob';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { processAccountErasure } from '../services/accountErasure/AccountErasureService';
import { findErasedAccountUsernames } from '../db/accountErasures/accountErasureRepository';

/**
 * BullMQ consumers (workers) for the federation queues.
 *
 * Worker placement (documented decision):
 * - The INBOX and DELIVERY workers run on EVERY backend process. Every task
 *   receives inbound AP POSTs and originates outbound deliveries, so processing
 *   throughput should scale with the fleet. BullMQ guarantees each job is
 *   delivered to exactly one worker, so running workers everywhere is safe.
 * - The PERIODIC worker also runs on every process, but the repeatable-job
 *   SCHEDULES are registered ONLY by the elected leader (see
 *   FederationJobScheduler). A repeatable job materializes exactly one delayed
 *   job per interval; any worker may consume it, and concurrency is pinned to 1
 *   so a periodic task never overlaps itself across the fleet.
 *
 * Workers are started once per process (guarded) and closed on shutdown.
 */

let inboxWorker: Worker<InboxJobData> | null = null;
let deliveryWorker: Worker<DeliveryJobData> | null = null;
let periodicWorker: Worker<PeriodicJobData> | null = null;
let sharingCleanupWorker: Worker<SharingCleanupJobData> | null = null;
let mediaMetadataEnrichWorker: Worker<MediaMetadataEnrichJobData> | null = null;
let accountErasureWorker: Worker<AccountErasureJobData> | null = null;
let workersStarted = false;

/**
 * Custom backoff strategy for delivery retries. Returns the delay (ms) before
 * the next attempt, indexed into {@link DELIVERY_BACKOFF_INTERVALS_MS} so the
 * retry cadence matches the legacy Mongo model's 6 tiers exactly.
 *
 * `attemptsMade` is the number of attempts already made (1 after the first
 * failure). Tier index is therefore `attemptsMade - 1`. A negative or
 * out-of-range index clamps to the array bounds as a safe floor/ceiling.
 */
function deliveryBackoff(attemptsMade: number): number {
  const lastIndex = DELIVERY_BACKOFF_INTERVALS_MS.length - 1;
  const index = Math.min(Math.max(attemptsMade - 1, 0), lastIndex);
  return DELIVERY_BACKOFF_INTERVALS_MS[index];
}

/**
 * Process one inbound activity. Delegates to the existing
 * `activityPubConnector.processInboxActivity`.
 *
 * Exported for unit testing — the BullMQ Worker is constructed with this as its
 * processor, so testing it directly avoids needing a live Redis connection.
 */
export async function processInboxJob(job: Job<InboxJobData>): Promise<void> {
  const { activity, verifiedActorUri } = job.data;
  await activityPubConnector.processInboxActivity(activity, verifiedActorUri);
}

/**
 * The sender's handle, from Oxy, or from the erasure ledger when Oxy no longer
 * resolves the account.
 *
 * The second source exists for one case: the `Delete` activities an account
 * erasure queues (`services/accountErasure`). Oxy has deleted the account by the
 * time they are delivered, so `getUserById` fails, yet the Delete must still be
 * signed under the actor's key id, which is minted from the handle. The ledger
 * keeps the handle for that window only. Every other sender resolves from Oxy
 * exactly as before; an Oxy error for a sender the ledger does not know is
 * rethrown so the job retries, as it always did.
 */
export async function resolveSenderUsername(senderOxyUserId: string): Promise<string | null> {
  let lookupError: unknown = null;
  try {
    const user = await getServiceOxyClient().getUserById(senderOxyUserId);
    if (user?.username) return user.username;
  } catch (error) {
    lookupError = error;
  }
  const erased = await findErasedAccountUsernames([senderOxyUserId]);
  const username = erased.get(senderOxyUserId);
  if (username) return username;
  if (lookupError !== null) throw lookupError;
  return null;
}

/**
 * Process one outbound delivery. Resolves the sender's username from the Oxy
 * client, signs + POSTs via `activityPubConnector.deliverActivity`, and throws on
 * a soft failure so BullMQ retries with the custom backoff. A missing sender is
 * a PERMANENT failure (UnrecoverableError) — no retry.
 *
 * Exported for unit testing (see {@link processInboxJob}).
 */
export async function processDeliveryJob(job: Job<DeliveryJobData>): Promise<void> {
  const { activityJson, targetInbox, senderOxyUserId } = job.data;

  // The sender's username is needed to load the signing key. Uses the
  // service-authed Oxy client — the process-wide request-auth client is
  // unauthenticated and reserved for validating incoming request tokens
  // (`oxy.auth()`), so resolving a user on it returns nothing.
  const username = await resolveSenderUsername(senderOxyUserId);
  if (!username) {
    logger.warn(
      '[FedDeliver] sender not found; dropping delivery',
    );
    throw new UnrecoverableError('Sender user not found');
  }

  const delivered = await activityPubConnector.deliverActivity(
    activityJson,
    targetInbox,
    senderOxyUserId,
    username,
  );

  if (!delivered) {
    // Soft failure (remote 4xx/5xx, timeout). Throw so BullMQ retries with the
    // tiered backoff until DELIVERY_JOB_ATTEMPTS is exhausted.
    throw new Error(`Delivery to ${targetInbox} failed (will retry)`);
  }
}

/**
 * Process one sharing-cleanup job. Delegates to `runSharingCleanup`, which is
 * already idempotent — a retry after a partial failure re-reads current state
 * and converges rather than double-sending.
 *
 * Exported for unit testing (see {@link processInboxJob}).
 */
export async function processSharingCleanupJob(job: Job<SharingCleanupJobData>): Promise<void> {
  const { oxyUserId, username } = job.data;
  await runSharingCleanup(oxyUserId, username);
}

/** Process one media-metadata enrich retry job. */
export async function processMediaMetadataEnrichWorkerJob(job: Job<MediaMetadataEnrichJobData>): Promise<void> {
  await processMediaMetadataEnrichJob(job.data.postId);
}

/**
 * Process one account-erasure job. `busy` (another task holds this account's
 * lease) throws so BullMQ retries later; an event with no ledger row cannot be
 * retried into existence and fails permanently.
 */
export async function processAccountErasureJob(job: Job<AccountErasureJobData>): Promise<void> {
  const result = await processAccountErasure(job.data.eventId);
  if (result.outcome === 'busy') {
    throw new Error('Another task holds this account erasure; retrying later');
  }
  if (result.outcome === 'unknown-event') {
    throw new UnrecoverableError('No account_erasures row for this event');
  }
}

/**
 * Dispatch a periodic job to the matching FederationJobScheduler task method.
 * The task implementations are unchanged — only the scheduling transport moved
 * to BullMQ.
 */
async function processPeriodicJob(job: Job<PeriodicJobData>): Promise<void> {
  const task: PeriodicTaskName = job.data.task;

  switch (task) {
    case 'refreshStaleActors':
      await federationJobScheduler.refreshStaleActors();
      break;
    case 'syncFollowedActorsPosts':
      await federationJobScheduler.syncFollowedActorsPosts();
      break;
    case 'syncRecentOutboxBackfills':
      await federationJobScheduler.syncRecentOutboxBackfills();
      break;
    case 'runMediaCacheWorker':
      await federationJobScheduler.runMediaCacheWorker();
      break;
    case 'runMediaCacheEviction':
      await federationJobScheduler.runMediaCacheEviction();
      break;
    case 'computeInterestScores':
      await federationJobScheduler.computeInterestScores();
      break;
    case 'flushEndorsementOutbox':
      await federationJobScheduler.flushEndorsementOutbox();
      break;
    case 'flushAffinityEvents':
      await federationJobScheduler.flushAffinityEvents();
      break;
    default: {
      // Exhaustiveness guard: an unknown task is a programming error, not a
      // transient failure — fail permanently rather than retry forever.
      const exhaustive: never = task;
      throw new UnrecoverableError(`Unknown periodic task: ${String(exhaustive)}`);
    }
  }
}

/**
 * Start the federation queue workers for this process. Idempotent — a second
 * call is a no-op. No-op when Redis is not configured.
 */
export function startWorkers(): void {
  if (workersStarted) return;
  if (!isQueueEnabled()) return;
  workersStarted = true;

  const connection = getQueueConnection();

  inboxWorker = new Worker<InboxJobData>(FEDERATION_INBOX_QUEUE, processInboxJob, {
    connection,
    concurrency: INBOX_WORKER_CONCURRENCY,
  });

  deliveryWorker = new Worker<DeliveryJobData>(FEDERATION_DELIVERY_QUEUE, processDeliveryJob, {
    connection,
    concurrency: DELIVERY_WORKER_CONCURRENCY,
    settings: {
      backoffStrategy: (attemptsMade: number, type?: string): number => {
        if (type === DELIVERY_BACKOFF_STRATEGY) return deliveryBackoff(attemptsMade);
        // Unknown strategy name — fall back to the first tier rather than 0.
        return DELIVERY_BACKOFF_INTERVALS_MS[0];
      },
    },
  });

  periodicWorker = new Worker<PeriodicJobData>(FEDERATION_PERIODIC_QUEUE, processPeriodicJob, {
    connection,
    concurrency: PERIODIC_WORKER_CONCURRENCY,
  });

  sharingCleanupWorker = new Worker<SharingCleanupJobData>(
    FEDERATION_SHARING_CLEANUP_QUEUE,
    processSharingCleanupJob,
    {
      connection,
      concurrency: SHARING_CLEANUP_WORKER_CONCURRENCY,
    },
  );

  mediaMetadataEnrichWorker = new Worker<MediaMetadataEnrichJobData>(
    MEDIA_METADATA_ENRICH_QUEUE,
    processMediaMetadataEnrichWorkerJob,
    {
      connection,
      concurrency: MEDIA_METADATA_ENRICH_WORKER_CONCURRENCY,
    },
  );

  accountErasureWorker = new Worker<AccountErasureJobData>(
    ACCOUNT_ERASURE_QUEUE,
    processAccountErasureJob,
    {
      connection,
      concurrency: ACCOUNT_ERASURE_WORKER_CONCURRENCY,
      // An erasure can run for minutes; the job lock must outlive a batch.
      lockDuration: 5 * 60 * 1000,
    },
  );

  for (const worker of [
    inboxWorker,
    deliveryWorker,
    periodicWorker,
    sharingCleanupWorker,
    mediaMetadataEnrichWorker,
    accountErasureWorker,
  ]) {
    worker.on('failed', (job, err) => {
      logger.warn('[Queue] job failed', {
        worker: worker.name,
        error: err,
        hasJob: Boolean(job),
      });
    });
    worker.on('error', (err) => {
      logger.error(`[Queue] worker ${worker.name} error`, err);
    });
  }

  logger.info('Queue workers started (inbox, delivery, periodic, sharing-cleanup, media-metadata-enrich, account-erasure)');
}

/**
 * Close all workers, producer queues, and the shared ioredis connection. Wired
 * into the server's graceful shutdown.
 */
export async function shutdownQueues(): Promise<void> {
  if (!workersStarted && !isQueueEnabled()) {
    return;
  }

  const workers: Array<
    | Worker<InboxJobData>
    | Worker<DeliveryJobData>
    | Worker<PeriodicJobData>
    | Worker<SharingCleanupJobData>
    | Worker<MediaMetadataEnrichJobData>
    | Worker<AccountErasureJobData>
  > = [];
  if (inboxWorker) workers.push(inboxWorker);
  if (deliveryWorker) workers.push(deliveryWorker);
  if (periodicWorker) workers.push(periodicWorker);
  if (sharingCleanupWorker) workers.push(sharingCleanupWorker);
  if (mediaMetadataEnrichWorker) workers.push(mediaMetadataEnrichWorker);
  if (accountErasureWorker) workers.push(accountErasureWorker);

  await Promise.allSettled(workers.map((w) => w.close()));

  inboxWorker = null;
  deliveryWorker = null;
  periodicWorker = null;
  sharingCleanupWorker = null;
  mediaMetadataEnrichWorker = null;
  accountErasureWorker = null;
  workersStarted = false;

  await closeQueues();
  await closeQueueConnection();

  logger.info('Federation queue workers + connections closed');
}
