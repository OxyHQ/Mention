import { Queue, type QueueOptions } from 'bullmq';
import { getQueueConnection, isQueueEnabled } from './connection';
import {
  FEDERATION_INBOX_QUEUE,
  FEDERATION_DELIVERY_QUEUE,
  FEDERATION_PERIODIC_QUEUE,
  FEDERATION_SHARING_CLEANUP_QUEUE,
  INBOX_REMOVE_ON_COMPLETE_COUNT,
  INBOX_REMOVE_ON_FAIL_COUNT,
  DELIVERY_REMOVE_ON_COMPLETE_COUNT,
  DELIVERY_REMOVE_ON_FAIL_COUNT,
  PERIODIC_REMOVE_ON_COMPLETE_COUNT,
  PERIODIC_REMOVE_ON_FAIL_COUNT,
  SHARING_CLEANUP_REMOVE_ON_COMPLETE_COUNT,
  SHARING_CLEANUP_REMOVE_ON_FAIL_COUNT,
} from './constants';
import type { InboxJobData, DeliveryJobData, PeriodicJobData, SharingCleanupJobData } from './types';

/**
 * Lazily-constructed BullMQ producer queues.
 *
 * Queues are created on first access (never at import time) and reuse the
 * single shared ioredis connection. Default job-retention options are applied
 * here so producers don't have to repeat them at every `add()` call.
 */

function baseQueueOptions(removeOnComplete: number, removeOnFail: number): QueueOptions {
  return {
    connection: getQueueConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: removeOnComplete },
      removeOnFail: { count: removeOnFail },
    },
  };
}

let inboxQueue: Queue<InboxJobData> | null = null;
let deliveryQueue: Queue<DeliveryJobData> | null = null;
let periodicQueue: Queue<PeriodicJobData> | null = null;
let sharingCleanupQueue: Queue<SharingCleanupJobData> | null = null;

/**
 * Get the inbound-activity queue, or null when Redis is not configured (callers
 * fall back to inline processing).
 */
export function getInboxQueue(): Queue<InboxJobData> | null {
  if (!isQueueEnabled()) return null;
  if (!inboxQueue) {
    inboxQueue = new Queue<InboxJobData>(
      FEDERATION_INBOX_QUEUE,
      baseQueueOptions(INBOX_REMOVE_ON_COMPLETE_COUNT, INBOX_REMOVE_ON_FAIL_COUNT),
    );
  }
  return inboxQueue;
}

/**
 * Get the outbound-delivery queue, or null when Redis is not configured
 * (callers fall back to the Mongo delivery queue).
 */
export function getDeliveryQueue(): Queue<DeliveryJobData> | null {
  if (!isQueueEnabled()) return null;
  if (!deliveryQueue) {
    deliveryQueue = new Queue<DeliveryJobData>(
      FEDERATION_DELIVERY_QUEUE,
      baseQueueOptions(DELIVERY_REMOVE_ON_COMPLETE_COUNT, DELIVERY_REMOVE_ON_FAIL_COUNT),
    );
  }
  return deliveryQueue;
}

/**
 * Get the periodic (repeatable-job) queue, or null when Redis is not
 * configured. Periodic schedules are registered onto this queue ONLY by the
 * elected scheduler leader.
 */
export function getPeriodicQueue(): Queue<PeriodicJobData> | null {
  if (!isQueueEnabled()) return null;
  if (!periodicQueue) {
    periodicQueue = new Queue<PeriodicJobData>(
      FEDERATION_PERIODIC_QUEUE,
      baseQueueOptions(PERIODIC_REMOVE_ON_COMPLETE_COUNT, PERIODIC_REMOVE_ON_FAIL_COUNT),
    );
  }
  return periodicQueue;
}

/**
 * Get the sharing-cleanup queue, or null when Redis is not configured (callers
 * fall back to inline fire-and-forget processing of `runSharingCleanup`).
 */
export function getSharingCleanupQueue(): Queue<SharingCleanupJobData> | null {
  if (!isQueueEnabled()) return null;
  if (!sharingCleanupQueue) {
    sharingCleanupQueue = new Queue<SharingCleanupJobData>(
      FEDERATION_SHARING_CLEANUP_QUEUE,
      baseQueueOptions(SHARING_CLEANUP_REMOVE_ON_COMPLETE_COUNT, SHARING_CLEANUP_REMOVE_ON_FAIL_COUNT),
    );
  }
  return sharingCleanupQueue;
}

/** Close all open producer queues. Internal — used by {@link shutdownQueues}. */
export async function closeQueues(): Promise<void> {
  const open: Array<Queue<InboxJobData> | Queue<DeliveryJobData> | Queue<PeriodicJobData> | Queue<SharingCleanupJobData>> = [];
  if (inboxQueue) open.push(inboxQueue);
  if (deliveryQueue) open.push(deliveryQueue);
  if (periodicQueue) open.push(periodicQueue);
  if (sharingCleanupQueue) open.push(sharingCleanupQueue);

  await Promise.allSettled(open.map((q) => q.close()));

  inboxQueue = null;
  deliveryQueue = null;
  periodicQueue = null;
  sharingCleanupQueue = null;
}
