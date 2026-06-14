import mongoose, { Document, Schema } from 'mongoose';

/**
 * Lifecycle state of a single federated/remote media URL in the activity-based
 * S3 cache.
 *
 * - `pending`: a cache job has been enqueued (or is in flight) for this URL; the
 *   proxy continues to stream from the remote upstream until the job completes.
 * - `cached`: the bytes live in Oxy S3 under {@link IFederatedMediaCache.oxyFileId};
 *   the proxy serves from Oxy and bumps {@link IFederatedMediaCache.lastAccessedAt}.
 * - `evicted`: the Oxy object(s) were deleted by the TTL eviction job because the
 *   URL went inactive. The row is KEPT (file ids cleared) so a future access
 *   re-enqueues a cache job and transitions back to `pending` → `cached`.
 * - `failed`: caching was attempted but exceeded the retry budget, the media was
 *   over the size cap, or it was not a cacheable media type. The proxy stays in
 *   remote-stream-only mode for this URL (no further cache attempts).
 */
export type FederatedMediaCacheState = 'pending' | 'cached' | 'evicted' | 'failed';

export const FEDERATED_MEDIA_CACHE_STATES: readonly FederatedMediaCacheState[] = [
  'pending',
  'cached',
  'evicted',
  'failed',
] as const;

export interface IFederatedMediaCache extends Document {
  /** The canonical remote media URL. This is the cache key — never rewritten. */
  remoteUrl: string;
  /** Oxy S3 file id for the cached media bytes (set only while `state==='cached'`). */
  oxyFileId?: string;
  /**
   * Oxy S3 file id for a video poster frame, when the cached media is a video
   * and a poster was successfully extracted. Cleared on eviction.
   */
  posterFileId?: string;
  /** Resolved upstream content type (e.g. `image/jpeg`, `video/mp4`). */
  contentType?: string;
  /** Size in bytes of the cached media (the body actually stored in Oxy). */
  sizeBytes?: number;
  /** Lifecycle state — see {@link FederatedMediaCacheState}. */
  state: FederatedMediaCacheState;
  /**
   * Last time this URL was requested through the proxy. Drives the activity-based
   * eviction job (entries idle past the TTL are evicted from S3).
   */
  lastAccessedAt: Date;
  /** When the media was successfully uploaded to Oxy (set on `cached`). */
  cachedAt?: Date;
  /**
   * Number of consecutive failed cache attempts. Used for backoff and to give up
   * (transition to `failed`) after a bounded number of attempts.
   */
  failCount: number;
  /**
   * Earliest time the cache worker may (re)attempt this URL. Set when a failed
   * attempt schedules a backoff; the worker skips `pending` entries whose
   * `nextAttemptAt` is still in the future.
   */
  nextAttemptAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const FederatedMediaCacheSchema = new Schema<IFederatedMediaCache>(
  {
    remoteUrl: { type: String, required: true, unique: true },
    oxyFileId: { type: String },
    posterFileId: { type: String },
    contentType: { type: String },
    sizeBytes: { type: Number },
    state: {
      type: String,
      required: true,
      enum: FEDERATED_MEDIA_CACHE_STATES,
      default: 'pending',
      index: true,
    },
    lastAccessedAt: { type: Date, required: true, default: Date.now, index: true },
    cachedAt: { type: Date },
    failCount: { type: Number, required: true, default: 0 },
    nextAttemptAt: { type: Date },
  },
  {
    timestamps: true,
  },
);

// Eviction job query: cached entries idle past the TTL, ordered by oldest access.
FederatedMediaCacheSchema.index({ state: 1, lastAccessedAt: 1 });
// Worker claim query: pending entries that are due (nextAttemptAt past / unset).
FederatedMediaCacheSchema.index({ state: 1, nextAttemptAt: 1 });

export const FederatedMediaCache = mongoose.model<IFederatedMediaCache>(
  'FederatedMediaCache',
  FederatedMediaCacheSchema,
);

export default FederatedMediaCache;
