import { loadPostRecord, replacePostContent } from '../db/posts/postRepository';
import { mediaMetadataService } from './MediaMetadataService';
import { logger } from '../utils/logger';
import { enqueueMediaMetadataEnrich as enqueueJob } from '../queue/producers';

/**
 * Re-resolve Oxy intrinsic metadata for a post's media items and persist when
 * changed. Used after create (when ffprobe may still be pending) and by the
 * BullMQ retry worker.
 */
export async function patchPostMediaMetadata(postId: string): Promise<boolean> {
  if (!postId) return false;

  const post = await loadPostRecord(postId);
  if (!post?.content.media || post.content.media.length === 0) {
    return false;
  }

  const current = post.content.media;
  const enriched = await mediaMetadataService.enrichFromOxy(current);

  const changed = enriched.some((item, index) => {
    const prev = current[index];
    return (
      item.width !== prev.width
      || item.height !== prev.height
      || item.durationSec !== prev.durationSec
      || item.orientation !== prev.orientation
      || item.aspectRatio !== prev.aspectRatio
      || item.sizeBytes !== prev.sizeBytes
    );
  });

  if (changed) {
    // The whole content graph, because `post_media` is a child table with a
    // dense `position`: enrichment rewrites every row's dimensions, so a
    // per-row update would have to renumber nothing but would still have to
    // touch each row, and `replacePostContent` already does that atomically.
    // `mentions` are re-supplied unchanged — this pass never touches them.
    await replacePostContent(postId, { ...post.content, media: enriched }, post.mentions);
  }

  return mediaMetadataService.needsOxyRetry(enriched);
}

/** Enqueue async metadata enrichment; returns false when Redis queue is unavailable. */
export async function enqueueMediaMetadataEnrich(postId: string): Promise<boolean> {
  return enqueueJob({ postId });
}

/**
 * Raised when Oxy has not finished deriving intrinsic media metadata yet.
 *
 * This is thrown, not logged, ON PURPOSE. BullMQ only re-runs a job that throws:
 * a handler that returns normally has consumed its single delivery, and the
 * queue's `attempts` / `backoff` settings never come into play. Returning here
 * is what this handler used to do, which left the retry — the entire reason the
 * job exists — permanently inert.
 *
 * Oxy derives width/height/durationSec by probing the asset AFTER the upload
 * call returns, so the first enrich attempt essentially always races that probe
 * and finds nothing. Every media item whose metadata arrives late depends on the
 * retry window, so "still pending" has to look like failure to the queue.
 *
 * An asset Oxy never derives metadata for (a small minority) exhausts `attempts`
 * and lands in the failed set. That is the honest outcome: a bounded, visible
 * give-up rather than a success that silently wrote nothing.
 */
export class MediaMetadataPendingError extends Error {
  constructor(postId: string) {
    super(`Oxy media metadata still pending for post ${postId}`);
    this.name = 'MediaMetadataPendingError';
  }
}

/** BullMQ worker entry — throws to request a retry while Oxy metadata is pending. */
export async function processMediaMetadataEnrichJob(postId: string): Promise<void> {
  let needsRetry: boolean;
  try {
    needsRetry = await patchPostMediaMetadata(postId);
  } catch (error) {
    logger.warn('[MediaMetadataEnrich] patch failed', {
      postId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  // Deliberately outside the catch above so a pending probe is not relabelled as
  // a patch failure — the two have different causes and different log levels.
  if (needsRetry) {
    logger.debug('[MediaMetadataEnrich] Oxy metadata still pending, requesting retry', { postId });
    throw new MediaMetadataPendingError(postId);
  }
}
