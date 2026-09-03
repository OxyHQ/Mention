import { logger } from '../utils/logger';

/**
 * Start all in-process schedulers. Invoked by LeaderElection ONLY on the task
 * that holds the scheduler leadership lock. Redis failure pauses all singleton
 * schedulers; the HTTP API may degrade, but no task self-elects without a
 * lease. Each service logs its own startup status.
 */
export function startSchedulers(): void {
  // Feed job scheduler
  try {
    const { feedJobScheduler } = require("../services/FeedJobScheduler");
    feedJobScheduler.start();
  } catch (error) {
    logger.warn("Failed to start feed job scheduler", error);
  }

  // Trending Service (30-min calculation interval)
  try {
    const { trendingService } = require("../services/TrendingService");
    trendingService.initialize();
  } catch (error) {
    logger.warn("Failed to initialize trending service", error);
  }

  // Post Classification Service (5-min interval; no-ops unless inference is configured)
  try {
    const { postClassificationService } = require("../services/PostClassificationService");
    postClassificationService.start();
  } catch (error) {
    logger.warn("Failed to start post classification service", error);
  }

  // Topic Service (daily AI enrichment of topic metadata)
  try {
    const { topicService } = require("../services/TopicService");
    topicService.start();
  } catch (error) {
    logger.warn("Failed to initialize topic service", error);
  }

  // Federation Job Scheduler (also owns the media-cache worker + eviction jobs)
  try {
    const { federationJobScheduler } = require("../services/FederationJobScheduler");
    federationJobScheduler.start();
  } catch (error) {
    logger.warn("Failed to start federation job scheduler", error);
  }

  // MTN Node Scheduler (B3 bidirectional node sync: leader-gated liveness probes
  // + ingest of pull nodes / export to push nodes). Background only — NEVER on a
  // request path; the feed/hydration hot path never queries a node.
  try {
    const { mentionNodeScheduler } = require("../services/mtn/MentionNodeScheduler");
    mentionNodeScheduler.start();
  } catch (error) {
    logger.warn("Failed to start MTN node scheduler", error);
  }

  // Follower Snapshot Job (leader-gated + env-gated on REDIS_URL): samples
  // follower counts for active authors, powering the `risingCreators` feed
  // source's follower-growth delta. Timers are unref'd; inline no-op without Redis.
  try {
    const { followerSnapshotJob } = require("../services/followerSnapshotJob");
    followerSnapshotJob.start();
  } catch (error) {
    logger.warn("Failed to start follower snapshot job", error);
  }

  // CrowdSource reconciliation (leader-gated, env-gated on CROWDSOURCE_ENABLED):
  // finds reports whose durable delivery event is missing or dead-lettered. The
  // outbox DISPATCHER runs on every task (lease-claimed in Postgres); this sweep
  // scans the whole table, so one task is enough.
  try {
    const { moderationReconciliationJob } = require("../services/moderation/ModerationReconciliationJob");
    moderationReconciliationJob.start();
  } catch (error) {
    logger.warn("Failed to start moderation reconciliation job", error);
  }

  // Blocklist proposal sweep (leader-gated): reads the blocklists other
  // instances publish and leaves newly corroborated domains in a review queue.
  // It PROPOSES only — it cannot block anything, by construction (see
  // services/federation/BlocklistProposalService). Due-ness lives in the run
  // history, not in this timer, so a weekly sweep still happens on a service
  // that redeploys daily.
  try {
    const { blocklistProposalScheduler } = require("../services/federation/BlocklistProposalScheduler");
    blocklistProposalScheduler.start();
  } catch (error) {
    logger.warn("Failed to start blocklist proposal scheduler", error);
  }
}

/**
 * Stop all in-process schedulers. Invoked by LeaderElection when this task
 * loses leadership (another task took over) or during graceful shutdown.
 * Each stop is isolated so one failure does not prevent stopping the rest.
 *
 * NOTE: FeedSeenPostsService's in-memory cleanup interval is intentionally NOT
 * stopped here — it is per-process memory hygiene for a request-time fallback
 * cache, not a shared cron job, so every task (leader or not) must keep it.
 */
export function stopSchedulers(): void {
  try {
    const { feedJobScheduler } = require("../services/FeedJobScheduler");
    feedJobScheduler.stop();
  } catch (error) {
    logger.warn("Failed to stop feed job scheduler", error);
  }

  try {
    const { trendingService } = require("../services/TrendingService");
    trendingService.cleanup();
  } catch (error) {
    logger.warn("Failed to stop trending service", error);
  }

  try {
    const { postClassificationService } = require("../services/PostClassificationService");
    postClassificationService.stop();
  } catch (error) {
    logger.warn("Failed to stop post classification service", error);
  }

  try {
    const { topicService } = require("../services/TopicService");
    topicService.stop();
  } catch (error) {
    logger.warn("Failed to stop topic service", error);
  }

  try {
    const { federationJobScheduler } = require("../services/FederationJobScheduler");
    federationJobScheduler.stop();
  } catch (error) {
    logger.warn("Failed to stop federation job scheduler", error);
  }

  try {
    const { mentionNodeScheduler } = require("../services/mtn/MentionNodeScheduler");
    mentionNodeScheduler.stop();
  } catch (error) {
    logger.warn("Failed to stop MTN node scheduler", error);
  }

  try {
    const { followerSnapshotJob } = require("../services/followerSnapshotJob");
    followerSnapshotJob.stop();
  } catch (error) {
    logger.warn("Failed to stop follower snapshot job", error);
  }

  try {
    const { moderationReconciliationJob } = require("../services/moderation/ModerationReconciliationJob");
    moderationReconciliationJob.stop();
  } catch (error) {
    logger.warn("Failed to stop moderation reconciliation job", error);
  }

  try {
    const { blocklistProposalScheduler } = require("../services/federation/BlocklistProposalScheduler");
    blocklistProposalScheduler.stop();
  } catch (error) {
    logger.warn("Failed to stop blocklist proposal scheduler", error);
  }
}
