/**
 * FeedInteractionTracker
 *
 * Tracks feed impressions, clicks, and engagement for feed quality improvement.
 * AT Protocol equivalent: app.bsky.feed.sendInteractions
 */

import mongoose from 'mongoose';
import { MtnConfig } from '@mention/shared-types';
import { logger } from '../../utils/logger';
import { isPostEligibleForViewTelemetry, recordDedupedView } from '../../services/feedViewCounter';
import { userPreferenceService } from '../../services/UserPreferenceService';

export type InteractionEvent = 'impression' | 'click' | 'like' | 'reply' | 'boost' | 'save';

export interface FeedInteractionData {
  userId: string;
  feedDescriptor: string;
  postUri: string;
  event: InteractionEvent;
  durationMs?: number;
  timestamp: Date;
}

/**
 * Record feed interactions for analytics and ranking feedback.
 * Writes to the FeedInteraction model asynchronously.
 */
export async function trackFeedInteraction(interaction: FeedInteractionData): Promise<void> {
  try {
    // Lazy import to avoid circular dependency at module load time
    const { FeedInteraction } = await import('../../models/FeedInteraction');
    await FeedInteraction.create({
      userId: interaction.userId,
      feedDescriptor: interaction.feedDescriptor,
      postUri: interaction.postUri,
      event: interaction.event,
      durationMs: interaction.durationMs,
      createdAt: interaction.timestamp,
    });
  } catch (error) {
    // Non-critical — log and move on
    logger.warn('[FeedInteractionTracker] Failed to record interaction', error);
  }

  // An impression carries TWO derived signals beyond the raw analytics row:
  //   1. a deduped increment of the post's real view count (ranking input), and
  //   2. a UserBehavior learning signal — a genuine `view` when the post was
  //      dwelled on, or a negative `skip` when it was scrolled past quickly.
  // Both are best-effort and MUST NOT fail the interaction record above, so they
  // run after it and swallow-then-log their own errors.
  if (interaction.event === 'impression') {
    applyImpressionSignals(interaction).catch((error) => {
      logger.warn('[FeedInteractionTracker] Failed to apply impression signals', error);
    });
  }
}

/**
 * Apply the deduped view-count increment and the UserBehavior learning signal
 * for a feed impression. `postUri` is the local post id (Mongo `_id` string);
 * federated/non-local uris that are not valid ObjectIds are skipped.
 */
async function applyImpressionSignals(interaction: FeedInteractionData): Promise<void> {
  const postId = interaction.postUri;
  if (!postId || !mongoose.isValidObjectId(postId)) {
    return; // Not a local post id — nothing to count or learn from.
  }

  // Client telemetry is untrusted: only derive view/preference side effects for
  // real public, published local posts. This prevents forged impressions from
  // mutating stats or learning against private/draft/nonexistent post ids.
  const eligible = await isPostEligibleForViewTelemetry(postId);
  if (!eligible) {
    return;
  }

  // 1. Deduped real view count (no-op without Redis / on duplicate).
  await recordDedupedView(postId, interaction.userId);

  // 2. UserBehavior signal. A short dwell is a SKIP (negative); a real dwell is
  //    a VIEW (mild positive). The frontend only reports impressions that passed
  //    its visibility gate, so `durationMs` is the accrued visible time. The
  //    originating feed is forwarded as the attribution surface so a video-feed
  //    view is attributed to video content, not the author.
  const dwellMs = interaction.durationMs ?? 0;
  const signal = dwellMs > 0 && dwellMs < MtnConfig.preferences.dwellSkipThresholdMs ? 'skip' : 'view';
  await userPreferenceService.recordInteraction(interaction.userId, postId, signal, {
    surface: interaction.feedDescriptor,
  });
}

/**
 * Record a batch of impressions (fire-and-forget).
 */
export function trackImpressions(
  userId: string,
  feedDescriptor: string,
  postUris: string[]
): void {
  const now = new Date();
  const interactions = postUris.map((uri) => ({
    userId,
    feedDescriptor,
    postUri: uri,
    event: 'impression' as const,
    timestamp: now,
  }));

  // Fire and forget — don't await
  Promise.all(interactions.map(trackFeedInteraction)).catch((error) => {
    logger.warn('[FeedInteractionTracker] Batch impression tracking failed', error);
  });
}
