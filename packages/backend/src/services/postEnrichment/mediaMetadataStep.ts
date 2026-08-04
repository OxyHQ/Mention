import type { MediaItem } from '@mention/shared-types';
import { mediaMetadataService } from '../MediaMetadataService';
import { enqueueMediaMetadataEnrich } from '../mediaMetadataEnrichJob';
import { logger } from '../../utils/logger';
import type { IngestedPost } from './types';

/**
 * Schedule the retry that collects Oxy's intrinsic media metadata
 * (width/height/durationSec/orientation).
 *
 * Oxy probes an asset asynchronously, so the inline `enrichFromOxy` that runs
 * while media is being materialized almost always beats the probe and comes
 * back empty. Without this second attempt a post's media stays permanently
 * dimension- and duration-less — which is exactly what happened to every
 * outbox-backfilled post for as long as this enqueue existed only on the native
 * storage route.
 *
 * Only posts that actually need a retry are enqueued.
 */
export function enrichMediaMetadata(posts: ReadonlyArray<IngestedPost>): void {
  for (const post of posts) {
    const media = post.content?.media as MediaItem[] | undefined;
    if (!Array.isArray(media) || !mediaMetadataService.needsOxyRetry(media)) continue;

    void enqueueMediaMetadataEnrich(post.id).catch((error: unknown) => {
      // An unavailable queue must never surface as an ingest failure.
      logger.debug('[PostEnrichment] Failed to enqueue media metadata enrich', {
        postId: post.id,
        reason: error instanceof Error ? error.message : 'unknown',
      });
    });
  }
}
