import { Post } from '../models/Post';
import type { MediaItem } from '@mention/shared-types';
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

  const post = await Post.findById(postId).select({ 'content.media': 1 }).lean();
  if (!post?.content?.media || !Array.isArray(post.content.media) || post.content.media.length === 0) {
    return false;
  }

  const current = post.content.media as MediaItem[];
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
    await Post.updateOne({ _id: postId }, { $set: { 'content.media': enriched } });
  }

  return mediaMetadataService.needsOxyRetry(enriched);
}

/** Enqueue async metadata enrichment; returns false when Redis queue is unavailable. */
export async function enqueueMediaMetadataEnrich(postId: string): Promise<boolean> {
  return enqueueJob({ postId });
}

/** BullMQ worker entry — returns whether another retry is warranted. */
export async function processMediaMetadataEnrichJob(postId: string): Promise<void> {
  try {
    const needsRetry = await patchPostMediaMetadata(postId);
    if (needsRetry) {
      logger.debug('[MediaMetadataEnrich] Oxy metadata still pending', { postId });
    }
  } catch (error) {
    logger.warn('[MediaMetadataEnrich] patch failed', {
      postId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
