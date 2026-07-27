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
 * username and calls `deliveryService.sendFollow`, which re-upserts the row to
 * pending and re-queues the Follow activity for delivery (dedupe-safe, so a
 * follow that IS already known to the remote is harmless to resend).
 *
 * Idempotent and safe to re-run. Runnable as a Fargate one-shot post-deploy:
 *   node dist/scripts/resendPendingOutboundFollows.js --dry-run
 *   node dist/scripts/resendPendingOutboundFollows.js
 */

import mongoose from 'mongoose';
import FederatedFollow from '../models/FederatedFollow';
import { deliveryService } from '../connectors/activitypub/delivery.service';
import { actorService } from '../connectors/activitypub/actor.service';
import {
  FEDERATION_ENABLED,
  federationUrls,
} from '../connectors/activitypub/constants';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { logger } from '../utils/logger';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import {
  assertAdminRunComplete,
  closeAdminScriptResources,
} from './lib/adminScriptLifecycle';

interface PendingFollowRow {
  _id: mongoose.Types.ObjectId;
  localUserId: string;
  remoteActorUri: string;
  activityId?: string;
}

async function queuePendingFollow(
  follow: PendingFollowRow,
  username: string,
): Promise<void> {
  let inbox = await deliveryService.resolveActorInbox(follow.remoteActorUri);
  if (!inbox) {
    const actor = await actorService.fetchRemoteActor(follow.remoteActorUri);
    inbox = actor?.sharedInboxUrl ?? actor?.inboxUrl;
  }
  if (!inbox) {
    throw new Error(`no resolvable inbox for ${follow.remoteActorUri}`);
  }

  const localActorUri = federationUrls.actor(username);
  const activityId =
    follow.activityId ??
    `${localActorUri}/follows/${encodeURIComponent(follow.remoteActorUri)}`;
  await deliveryService.queueDelivery(
    {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: activityId,
      type: 'Follow',
      actor: localActorUri,
      object: follow.remoteActorUri,
    },
    inbox,
    follow.localUserId,
  );
}

async function resendPendingOutboundFollows(): Promise<void> {
  const startedAt = Date.now();
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
  const dbName = `mention-${process.env.NODE_ENV || 'development'}`;
  const dryRun = process.argv.includes('--dry-run');

  try {
    assertAdminMutationAllowed({
      scriptName: 'resendPendingOutboundFollows',
      dryRun,
    });
    if (!FEDERATION_ENABLED && !dryRun) {
      // With federation disabled `sendFollow` no-ops, so re-delivery is
      // impossible. Fail loudly rather than silently "succeeding" on zero work.
      throw new Error('FEDERATION_ENABLED is false; nothing to do');
    }

    await mongoose.connect(mongoUri, { dbName });
    logger.info('[resendPendingOutboundFollows] connected to MongoDB', { dryRun });

    const pending = await FederatedFollow.find(
      { direction: 'outbound', status: 'pending' },
      { _id: 1, localUserId: 1, remoteActorUri: 1, activityId: 1 },
    ).lean<PendingFollowRow[]>();

    logger.info(`[resendPendingOutboundFollows] ${pending.length} pending outbound follows to re-deliver`);

    if (pending.length === 0) {
      logger.info('[resendPendingOutboundFollows] nothing to do');
      return;
    }

    if (dryRun) {
      logger.info(
        `[resendPendingOutboundFollows] DRY-RUN: would re-deliver up to ${pending.length} pending outbound follows`,
      );
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
          logger.warn('[resendPendingOutboundFollows] local username unavailable; follow skipped');
          continue;
        }

        // Queue the deterministic Follow activity through an awaited durable
        // producer. `sendFollow` intentionally detaches this work for request
        // latency and is therefore unsuitable for a terminating one-shot.
        await queuePendingFollow(follow, username);
        resent += 1;
      } catch (err) {
        failed += 1;
        logger.warn('[resendPendingOutboundFollows] follow re-delivery failed', { error: err });
      }
    }

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[resendPendingOutboundFollows] done: ${resent} re-delivered, ${skipped} skipped, ${failed} failed of ${pending.length} (${elapsedSeconds}s)`,
    );

    assertAdminRunComplete('resendPendingOutboundFollows', {
      skipped,
      failed,
    });
  } catch (error) {
    logger.error('[resendPendingOutboundFollows] failed', error);
    throw error;
  } finally {
    await closeAdminScriptResources();
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  // Exit deterministically: imported singletons (BullMQ Redis connection, media
  // cache workers) keep the event loop alive, so the process would otherwise sit
  // RUNNING for minutes after the work completes. Mirrors backfillFederatedBanners.
  resendPendingOutboundFollows()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[resendPendingOutboundFollows] unhandled failure', error);
      process.exit(1);
    });
}

export default resendPendingOutboundFollows;
