import { createWriteStream } from 'node:fs';
import { mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage } from 'node:http';

import FederatedMediaCache from '../../models/FederatedMediaCache';
import { logger } from '../../utils/logger';
import {
  SsrfRejection,
  fetchUpstreamFollowingRedirects,
  contentTypeFamily,
} from '../../utils/safeUpstreamFetch';
import { extractPosterFrame } from '../../utils/videoPoster';
import {
  MEDIA_CACHE_POSTER_PREFIX_BYTES,
  MEDIA_CACHE_WORKER_BATCH_SIZE,
  MEDIA_CACHE_WORKER_CONCURRENCY,
} from './constants';
import {
  classifyFailure,
  isCacheableMediaType,
  isVideoType,
  maxBytesForType,
} from './policy';
import {
  MediaStoreUnavailableError,
  deleteCachedMedia,
  isMediaStoreWriteEnabled,
  uploadCachedMedia,
} from './oxyMediaStore';

/** Random bytes for temp filenames (collision resistance). */
const TEMP_NAME_RANDOM_BYTES = 16;
/** Per-download temp directory prefix under the OS tmpdir. */
const TEMP_DIR_PREFIX = 'mention-media-cache-';
/** Idle socket timeout while streaming the body to a temp file. */
const DOWNLOAD_SOCKET_TIMEOUT_MS = 30_000;
/** HTTP status that carries a full body we can cache. */
const HTTP_OK = 200;
/** MIME type for the extracted video poster image uploaded to Oxy. */
const POSTER_CONTENT_TYPE = 'image/jpeg';
/** Derived filename for the extracted video poster image. */
const POSTER_FILENAME = 'poster.jpg';

interface DownloadResult {
  filePath: string;
  contentType: string;
  sizeBytes: number;
}

type DownloadOutcome =
  | { ok: true; download: DownloadResult }
  | { ok: false; reason: 'not-media' | 'too-large' | 'upstream-error' | 'ssrf' };

/**
 * Stream a remote media body to a local temp file, enforcing the per-type size
 * cap. Never buffers the whole body in memory. The caller owns cleanup of the
 * temp directory (passed in) in its `finally`.
 */
async function downloadToTempFile(remoteUrl: string, dir: string): Promise<DownloadOutcome> {
  const abortController = new AbortController();
  let response: IncomingMessage | null = null;

  try {
    const upstream = await fetchUpstreamFollowingRedirects(remoteUrl, {}, abortController.signal);
    response = upstream.response;
  } catch (error) {
    if (error instanceof SsrfRejection) {
      logger.warn('[MediaCache] Worker rejected SSRF target', { reason: error.message });
      return { ok: false, reason: 'ssrf' };
    }
    logger.warn('[MediaCache] Worker upstream fetch failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return { ok: false, reason: 'upstream-error' };
  }

  const status = response.statusCode ?? 0;
  if (status !== HTTP_OK) {
    response.resume();
    logger.warn('[MediaCache] Worker upstream returned non-OK', { status });
    return { ok: false, reason: 'upstream-error' };
  }

  const contentType = contentTypeFamily(response.headers);
  if (!isCacheableMediaType(contentType)) {
    response.destroy();
    logger.info('[MediaCache] Worker skipping non-cacheable media type', {
      contentType: contentType || 'unknown',
    });
    return { ok: false, reason: 'not-media' };
  }

  const maxBytes = maxBytesForType(contentType);

  // Reject over-large declared bodies up front (streamed bytes are capped too).
  const declared = Number(response.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.destroy();
    logger.info('[MediaCache] Worker skipping over-cap media (declared)', {
      declared,
      maxBytes,
      contentType,
    });
    return { ok: false, reason: 'too-large' };
  }

  const filePath = join(dir, `${randomBytes(TEMP_NAME_RANDOM_BYTES).toString('hex')}.bin`);

  response.setTimeout(DOWNLOAD_SOCKET_TIMEOUT_MS, () => {
    response?.destroy(new Error('upstream socket idle timeout'));
  });

  // Enforce the byte cap mid-stream: destroy the socket the moment we exceed it
  // rather than silently truncating (LOG the skip, never store a partial file).
  let streamed = 0;
  let overCap = false;
  response.on('data', (chunk: Buffer) => {
    streamed += chunk.length;
    if (streamed > maxBytes && !overCap) {
      overCap = true;
      logger.info('[MediaCache] Worker aborting over-cap media (streamed)', {
        streamed,
        maxBytes,
        contentType,
      });
      response?.destroy(new Error('media exceeds size cap'));
    }
  });

  const out = createWriteStream(filePath);
  try {
    await pipeline(response, out);
  } catch (error) {
    if (overCap) {
      return { ok: false, reason: 'too-large' };
    }
    logger.warn('[MediaCache] Worker stream-to-disk failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return { ok: false, reason: 'upstream-error' };
  }

  const { size } = await stat(filePath);
  return { ok: true, download: { filePath, contentType, sizeBytes: size } };
}

/** Read a bounded leading prefix of a local file (for poster extraction). */
async function readFilePrefix(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Process a single `pending` cache entry: download → upload to Oxy → (video)
 * extract+upload poster → mark `cached`. On failure, apply backoff or give up
 * (`failed`) per the policy. Idempotent and self-cleaning (temp dir removed in
 * `finally`). Best-effort cleanup of an orphaned media upload if the poster
 * step throws after the media upload succeeded.
 */
async function processEntry(remoteUrl: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
  let uploadedMediaFileId: string | undefined;

  try {
    const outcome = await downloadToTempFile(remoteUrl, dir);

    if (!outcome.ok) {
      // not-media / too-large are permanent for this URL → mark failed (proxy-only).
      if (outcome.reason === 'not-media' || outcome.reason === 'too-large') {
        await FederatedMediaCache.updateOne(
          { remoteUrl },
          { $set: { state: 'failed' }, $unset: { nextAttemptAt: '' } },
        );
        return;
      }
      // Transient (upstream-error / ssrf) → backoff or give up.
      await applyFailureBackoff(remoteUrl);
      return;
    }

    const { filePath, contentType, sizeBytes } = outcome.download;
    const media = await uploadCachedMedia({
      filePath,
      contentType,
      originalName: deriveFilename(remoteUrl, contentType),
      sizeBytes,
    });
    uploadedMediaFileId = media.oxyFileId;

    let posterFileId: string | undefined;
    if (isVideoType(contentType)) {
      posterFileId = await extractAndUploadPoster(filePath, dir);
    }

    await FederatedMediaCache.updateOne(
      { remoteUrl },
      {
        $set: {
          state: 'cached',
          oxyFileId: media.oxyFileId,
          posterFileId,
          contentType,
          sizeBytes,
          cachedAt: new Date(),
          failCount: 0,
        },
        $unset: { nextAttemptAt: '' },
      },
    );
  } catch (error) {
    if (error instanceof MediaStoreUnavailableError) {
      // Upload capability is not available — do NOT churn failCount toward a
      // permanent `failed`; just log. The job-level guard prevents reaching here.
      logger.error('[MediaCache] Media store unavailable during caching', {
        reason: error.message,
      });
    } else {
      logger.warn('[MediaCache] Worker entry failed', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      await applyFailureBackoff(remoteUrl);
    }

    // Clean up an orphaned media upload if a later step threw.
    if (uploadedMediaFileId) {
      await deleteCachedMedia(uploadedMediaFileId).catch((cleanupError: unknown) => {
        logger.warn('[MediaCache] Failed to clean up orphaned media upload', {
          oxyFileId: uploadedMediaFileId,
          reason: cleanupError instanceof Error ? cleanupError.message : 'unknown',
        });
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
      logger.warn('[MediaCache] Failed to remove worker temp dir', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
    });
  }
}

/**
 * Extract a poster frame from the local video file and upload it to Oxy. The
 * (small, bounded) JPEG is written to a temp file inside the worker's `dir` and
 * streamed to Oxy, keeping the upload boundary uniformly file-stream based.
 */
async function extractAndUploadPoster(filePath: string, dir: string): Promise<string | undefined> {
  const prefix = await readFilePrefix(filePath, MEDIA_CACHE_POSTER_PREFIX_BYTES);
  if (prefix.length === 0) return undefined;

  const poster = await extractPosterFrame(prefix);
  if (!poster.ok) {
    logger.info('[MediaCache] Poster extraction yielded no frame', { reason: poster.reason });
    return undefined;
  }

  const posterPath = join(dir, `${randomBytes(TEMP_NAME_RANDOM_BYTES).toString('hex')}.jpg`);
  await writeFile(posterPath, poster.jpeg);
  const uploaded = await uploadCachedMedia({
    filePath: posterPath,
    contentType: POSTER_CONTENT_TYPE,
    originalName: POSTER_FILENAME,
    sizeBytes: poster.jpeg.byteLength,
  });
  return uploaded.oxyFileId;
}

/** Increment failCount and either schedule a backoff or mark `failed`. */
async function applyFailureBackoff(remoteUrl: string): Promise<void> {
  const updated = await FederatedMediaCache.findOneAndUpdate(
    { remoteUrl },
    { $inc: { failCount: 1 } },
    { returnDocument: 'after' },
  ).lean<{ failCount: number } | null>();

  if (!updated) return;

  const outcome = classifyFailure(updated.failCount);
  if (outcome.giveUp) {
    await FederatedMediaCache.updateOne(
      { remoteUrl },
      { $set: { state: 'failed' }, $unset: { nextAttemptAt: '' } },
    );
    return;
  }

  await FederatedMediaCache.updateOne(
    { remoteUrl },
    { $set: { nextAttemptAt: new Date(Date.now() + outcome.nextAttemptInMs) } },
  );
}

/** Derive a stable, safe filename for the Oxy upload from the URL + type. */
function deriveFilename(remoteUrl: string, contentType: string): string {
  let base = 'media';
  try {
    const { pathname } = new URL(remoteUrl);
    const last = pathname.split('/').filter(Boolean).pop();
    if (last) base = last.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
  } catch {
    // Keep the default base; the URL was validated elsewhere, this is cosmetic.
    logger.debug('[MediaCache] Could not derive filename from URL');
  }
  if (!base.includes('.')) {
    const subtype = contentType.split('/')[1]?.split(';')[0];
    if (subtype) base = `${base}.${subtype}`;
  }
  return base;
}

/**
 * Drain a bounded batch of due `pending` entries with bounded concurrency.
 * No-ops when the write side is disabled (upload capability blocked upstream),
 * so no broken upload traffic is generated. Overlap-guarded by the scheduler.
 */
export async function runCacheWorkerOnce(): Promise<void> {
  if (!isMediaStoreWriteEnabled()) {
    logger.debug('[MediaCache] Worker skipped — media store write disabled (blocked upstream)');
    return;
  }

  const now = new Date();
  const due = await FederatedMediaCache.find({
    state: 'pending',
    $or: [{ nextAttemptAt: { $lte: now } }, { nextAttemptAt: null }, { nextAttemptAt: { $exists: false } }],
  })
    .select('remoteUrl')
    .sort({ lastAccessedAt: -1 })
    .limit(MEDIA_CACHE_WORKER_BATCH_SIZE)
    .lean<{ remoteUrl: string }[]>();

  if (due.length === 0) return;

  logger.info(`[MediaCache] Caching ${due.length} pending media entries`);

  for (let i = 0; i < due.length; i += MEDIA_CACHE_WORKER_CONCURRENCY) {
    const batch = due.slice(i, i + MEDIA_CACHE_WORKER_CONCURRENCY);
    await Promise.allSettled(batch.map((entry) => processEntry(entry.remoteUrl)));
  }
}
