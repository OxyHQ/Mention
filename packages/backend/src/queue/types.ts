/**
 * Explicit, fully-typed job payloads for the federation BullMQ queues.
 *
 * Payloads carry only plain JSON-serializable data — BullMQ persists them in
 * Redis, so no Mongoose documents, class instances, or functions may be placed
 * here.
 */

/** Inbound activity awaiting `processInboxActivity`. */
export interface InboxJobData {
  /** The raw ActivityPub activity object as received and verified. */
  activity: Record<string, unknown>;
  /** The actor URI that was cryptographically verified against the signature. */
  verifiedActorUri: string;
}

/** Outbound signed delivery to a single remote inbox. */
export interface DeliveryJobData {
  /** The ActivityPub activity to deliver. */
  activityJson: Record<string, unknown>;
  /** Absolute URL of the destination inbox (or shared inbox). */
  targetInbox: string;
  /** Oxy user id of the local sender (used to resolve signing key + username). */
  senderOxyUserId: string;
}

/** Discriminator for which periodic federation task a repeatable job runs. */
export type PeriodicTaskName =
  | 'refreshStaleActors'
  | 'syncFollowedActorsPosts'
  | 'syncRecentOutboxBackfills'
  | 'runMediaCacheWorker'
  | 'runMediaCacheEviction'
  | 'computeInterestScores'
  | 'flushEndorsementOutbox'
  | 'flushAffinityEvents';

/** Payload for a periodic (repeatable) federation maintenance job. */
export interface PeriodicJobData {
  task: PeriodicTaskName;
}

/**
 * One-off Delete(actor) + follower teardown dispatched when a user turns
 * fediverse sharing OFF. `nonce` is used only to key the dedupe jobId
 * (`enqueueSharingCleanup`) — `runSharingCleanup` mints its own nonce for the
 * Delete activity's `id`.
 */
export interface SharingCleanupJobData {
  oxyUserId: string;
  username: string;
  nonce: string;
}
