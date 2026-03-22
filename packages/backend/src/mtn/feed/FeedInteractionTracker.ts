/**
 * FeedInteractionTracker
 *
 * Tracks feed impressions, clicks, and engagement for feed quality improvement.
 * AT Protocol equivalent: app.bsky.feed.sendInteractions
 */

import { logger } from '../../utils/logger';

export type InteractionEvent = 'impression' | 'click' | 'like' | 'reply' | 'repost' | 'save';

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
