import { logger } from '../utils/logger';
import { FEDERATION_ENABLED } from '../utils/federation/constants';
import FederatedActor from '../models/FederatedActor';
import FederatedFollow from '../models/FederatedFollow';
import FederationDeliveryQueue, { getNextRetryTime } from '../models/FederationDeliveryQueue';
import { federationService } from './FederationService';

class FederationJobScheduler {
  private actorRefreshInterval: ReturnType<typeof setInterval> | null = null;
  private deliveryRetryInterval: ReturnType<typeof setInterval> | null = null;

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
    logger.info('Federation job scheduler stopped');
  }

  /**
   * Refresh actor profiles that are stale (>24h) and have active follows.
   */
  private async refreshStaleActors(): Promise<void> {
    const staleThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Get actor URIs that have active follows
    const activeFollows = await FederatedFollow.distinct('remoteActorUri', {
      status: 'accepted',
    });

    if (activeFollows.length === 0) return;

    const staleActors = await FederatedActor.find({
      uri: { $in: activeFollows },
      $or: [
        { lastFetchedAt: { $lt: staleThreshold } },
        { lastFetchedAt: null },
      ],
    })
      .select('uri')
      .limit(50) // Process in batches
      .lean();

    if (staleActors.length === 0) return;

    logger.debug(`Refreshing ${staleActors.length} stale actor profiles`);

    for (const actor of staleActors) {
      try {
        await federationService.fetchRemoteActor(actor.uri);
      } catch (err) {
        logger.debug(`Failed to refresh actor ${actor.uri}:`, err);
      }
    }
  }

  /**
   * Retry pending deliveries whose nextAttemptAt has passed.
   */
  private async retryFailedDeliveries(): Promise<void> {
    const now = new Date();

    const pending = await FederationDeliveryQueue.find({
      status: 'pending',
      nextAttemptAt: { $lte: now },
    })
      .limit(50) // Process in batches
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
            { $set: { status: 'delivered', lastAttemptAt: now } },
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
  }
}

export const federationJobScheduler = new FederationJobScheduler();
export default federationJobScheduler;
