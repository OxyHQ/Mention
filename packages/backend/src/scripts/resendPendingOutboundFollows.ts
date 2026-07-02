/**
 * One-shot repair: re-deliver every outbound Follow that is stuck `pending`.
 *
 * A Follow we sent to a remote actor stays `direction:'outbound', status:'pending'`
 * in `FederatedFollow` until the remote replies with an Accept. When the original
 * delivery never left our edge (e.g. the historical Cloudflare 301 on
 * `mention.earth/ap/*`, or an inbox that wasn't resolved at send time), the row
 * lingers pending and the remote never learns we want to follow.
 *
 * For each pending outbound follow this resolves the local user's CURRENT Oxy
 * username and calls `followService.sendFollow`, which re-upserts the row to
 * pending and re-queues the Follow activity for delivery (dedupe-safe, so a
 * follow that IS already known to the remote is harmless to resend).
 *
 * Idempotent and safe to re-run. Runnable as a Fargate one-shot post-deploy:
 *   node dist/scripts/resendPendingOutboundFollows.js
 */

import mongoose from 'mongoose';
import FederatedFollow from '../models/FederatedFollow';
import { followService } from '../connectors/activitypub/follow.service';
import { FEDERATION_ENABLED } from '../connectors/activitypub/constants';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { logger } from '../utils/logger';

/**
 * Grace period to let `sendFollow`'s fire-and-forget delivery/enqueue promises
 * flush before the process disconnects and exits. `sendFollow` awaits the
 * durable `FederatedFollow` re-upsert but detaches the actual inbox resolution
 * and delivery/queue write; a one-shot must not exit before those complete.
 */
const DELIVERY_SETTLE_MS = 15_000;

interface PendingFollowRow {
  _id: mongoose.Types.ObjectId;
  localUserId: string;
  remoteActorUri: string;
}

async function resendPendingOutboundFollows(): Promise<void> {
  const startedAt = Date.now();
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
  const dbName = `mention-${process.env.NODE_ENV || 'development'}`;

  try {
    if (!FEDERATION_ENABLED) {
      // With federation disabled `sendFollow` no-ops, so re-delivery is
      // impossible. Fail loudly rather than silently "succeeding" on zero work.
      logger.error('[resendPendingOutboundFollows] FEDERATION_ENABLED is false; nothing to do');
      process.exit(1);
    }

    await mongoose.connect(mongoUri, { dbName });
    logger.info(`[resendPendingOutboundFollows] connected to MongoDB (${dbName})`);

    const pending = await FederatedFollow.find(
      { direction: 'outbound', status: 'pending' },
      { _id: 1, localUserId: 1, remoteActorUri: 1 },
    ).lean<PendingFollowRow[]>();

    logger.info(`[resendPendingOutboundFollows] ${pending.length} pending outbound follows to re-deliver`);

    if (pending.length === 0) {
      logger.info('[resendPendingOutboundFollows] nothing to do');
      await mongoose.disconnect();
      return;
    }

    let resent = 0;
    let skipped = 0;
    let failed = 0;

    for (const follow of pending) {
      try {
        const user = await getServiceOxyClient().getUserById(follow.localUserId);
        const username = user?.username;
        if (!username) {
          skipped += 1;
          logger.warn(
            `[resendPendingOutboundFollows] skipping ${follow.remoteActorUri}: no username for local user ${follow.localUserId}`,
          );
          continue;
        }

        await followService.sendFollow(follow.localUserId, username, follow.remoteActorUri);
        resent += 1;
      } catch (err) {
        failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          `[resendPendingOutboundFollows] failed to re-deliver follow to ${follow.remoteActorUri} for ${follow.localUserId}: ${message}`,
        );
      }
    }

    // Allow the detached delivery/enqueue work triggered above to flush before
    // tearing down the connection and exiting.
    await new Promise((resolve) => setTimeout(resolve, DELIVERY_SETTLE_MS));

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[resendPendingOutboundFollows] done: ${resent} re-delivered, ${skipped} skipped, ${failed} failed of ${pending.length} (${elapsedSeconds}s)`,
    );

    await mongoose.disconnect();
  } catch (error) {
    logger.error('[resendPendingOutboundFollows] failed', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

if (require.main === module) {
  resendPendingOutboundFollows();
}

export default resendPendingOutboundFollows;
