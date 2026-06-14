import FederatedMediaCache, { type IFederatedMediaCache } from '../../models/FederatedMediaCache';
import { logger } from '../../utils/logger';
import {
  MEDIA_CACHE_EVICTION_BATCH_SIZE,
  MEDIA_CACHE_EVICTION_CONCURRENCY,
  MEDIA_CACHE_TTL_MS,
} from './constants';
import { deleteCachedMedia, isMediaCacheEnabled } from './oxyMediaStore';

type EvictionCandidate = Pick<IFederatedMediaCache, 'remoteUrl' | 'oxyFileId' | 'posterFileId'>;

/**
 * Delete the Oxy object(s) for one idle entry and transition it to `evicted`,
 * KEEPING the row (file ids cleared) so a future access re-caches it. If a
 * delete fails the row is left `cached` so the next sweep retries — we never
 * mark `evicted` while bytes may still live in S3 (avoids orphaned objects).
 */
async function evictOne(candidate: EvictionCandidate): Promise<void> {
  const fileIds = [candidate.oxyFileId, candidate.posterFileId].filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );

  // Delete every associated object first; only flip to `evicted` if all succeed.
  const results = await Promise.allSettled(fileIds.map((id) => deleteCachedMedia(id)));
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length > 0) {
    logger.warn('[MediaCache] Eviction delete failed; leaving entry cached for retry', {
      remoteUrl: candidate.remoteUrl,
      failedCount: failed.length,
    });
    return;
  }

  await FederatedMediaCache.updateOne(
    { remoteUrl: candidate.remoteUrl, state: 'cached' },
    {
      $set: { state: 'evicted' },
      $unset: { oxyFileId: '', posterFileId: '', cachedAt: '', sizeBytes: '' },
    },
  );
}

/**
 * Evict `cached` entries idle past {@link MEDIA_CACHE_TTL_MS} from Oxy S3.
 * Bounded batch + bounded concurrency, no-ops when the write side is disabled
 * (delete capability blocked upstream). Overlap-guarded by the scheduler.
 */
export async function runEvictionOnce(): Promise<void> {
  if (!isMediaCacheEnabled()) {
    logger.debug('[MediaCache] Eviction skipped — media cache disabled (blocked upstream)');
    return;
  }

  const cutoff = new Date(Date.now() - MEDIA_CACHE_TTL_MS);
  const candidates = await FederatedMediaCache.find({
    state: 'cached',
    lastAccessedAt: { $lt: cutoff },
  })
    .select('remoteUrl oxyFileId posterFileId')
    .sort({ lastAccessedAt: 1 })
    .limit(MEDIA_CACHE_EVICTION_BATCH_SIZE)
    .lean<EvictionCandidate[]>();

  if (candidates.length === 0) return;

  logger.info(`[MediaCache] Evicting ${candidates.length} idle cached media entries`);

  for (let i = 0; i < candidates.length; i += MEDIA_CACHE_EVICTION_CONCURRENCY) {
    const batch = candidates.slice(i, i + MEDIA_CACHE_EVICTION_CONCURRENCY);
    await Promise.allSettled(batch.map((candidate) => evictOne(candidate)));
  }
}
