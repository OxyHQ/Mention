/**
 * Both media-cache sweeps stop when Oxy says this app's write budget is spent.
 *
 * Oxy caps media-cache writes per application and per minute. When the cap is
 * reached it answers 429 — a statement about the WINDOW, not about the object —
 * and neither sweep noticed: the worker fired its whole batch and the eviction
 * job its whole page, so ONE spent budget became dozens of refused requests and
 * dozens of warn lines. Measured in production before this: 54 upload 429s in
 * two minutes for ~32 queued entries, and 50 eviction deletes failing per sweep,
 * on every sweep.
 *
 * What must hold, and is asserted here:
 *  - the sweep stops at the first refusal rather than buying one per item,
 *  - the rows are left where the next sweep can take them (`pending` /
 *    `cached`), and
 *  - a refused entry is NOT counted as that entry's failure — a fail count would
 *    push a perfectly good URL toward `failed` for being queued at a busy minute.
 */
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ThrottledError, mocks } = vi.hoisted(() => {
  /** Stands in for the store's own throttled error; `isMediaStoreThrottled` matches it. */
  class ThrottledError extends Error {
    readonly operation: 'upload' | 'delete';
    readonly retryAfterMs = 60_000;
    constructor(operation: 'upload' | 'delete') {
      super(`Oxy media store ${operation} budget is spent for this window`);
      this.name = 'OxyMediaStoreThrottledError';
      this.operation = operation;
    }
  }

  return {
    ThrottledError,
    mocks: {
      fetchUpstreamFollowingRedirects: vi.fn(),
      uploadCachedMedia: vi.fn(),
      uploadFederatedMedia: vi.fn(),
      deleteCachedMedia: vi.fn(),
      findDueMediaCacheEntries: vi.fn(),
      markMediaCacheCached: vi.fn(),
      markMediaCacheFailed: vi.fn(),
      incrementMediaCacheFailCount: vi.fn(),
      scheduleMediaCacheRetry: vi.fn(),
      findEvictableMediaCacheEntries: vi.fn(),
      markMediaCacheEvicted: vi.fn(),
    },
  };
});

vi.mock('../../utils/safeUpstreamFetch', async () => {
  class SsrfRejection extends Error {}
  const contentTypeFamilyFromString = (raw: string | undefined) =>
    typeof raw === 'string' ? (raw.split(';')[0]?.trim().toLowerCase() ?? '') : '';
  return {
    SsrfRejection,
    fetchUpstreamFollowingRedirects: mocks.fetchUpstreamFollowingRedirects,
    contentTypeFamilyFromString,
    contentTypeFamily: (headers: Record<string, unknown>) =>
      contentTypeFamilyFromString(
        typeof headers['content-type'] === 'string' ? (headers['content-type'] as string) : undefined,
      ),
  };
});

vi.mock('../../services/mediaCache/oxyMediaStore', () => ({
  MediaStoreUnavailableError: class MediaStoreUnavailableError extends Error {},
  OxyMediaStoreThrottledError: ThrottledError,
  isMediaStoreThrottled: (error: unknown) => error instanceof ThrottledError,
  isMediaCacheEnabled: () => true,
  uploadCachedMedia: mocks.uploadCachedMedia,
  uploadFederatedMedia: mocks.uploadFederatedMedia,
  deleteCachedMedia: mocks.deleteCachedMedia,
}));

vi.mock('../../db/federation/mediaCacheRepository', () => ({
  findDueMediaCacheEntries: mocks.findDueMediaCacheEntries,
  markMediaCacheCached: mocks.markMediaCacheCached,
  markMediaCacheFailed: mocks.markMediaCacheFailed,
  incrementMediaCacheFailCount: mocks.incrementMediaCacheFailCount,
  scheduleMediaCacheRetry: mocks.scheduleMediaCacheRetry,
  findEvictableMediaCacheEntries: mocks.findEvictableMediaCacheEntries,
  markMediaCacheEvicted: mocks.markMediaCacheEvicted,
}));

import { runCacheWorkerOnce } from '../../services/mediaCache/cacheWorker';
import {
  MEDIA_CACHE_EVICTION_CONCURRENCY,
  MEDIA_CACHE_WORKER_CONCURRENCY,
} from '../../services/mediaCache/constants';
import { runEvictionOnce } from '../../services/mediaCache/evictionJob';

/** An upstream image response the download step accepts. */
function imageResponse(bytes: Buffer) {
  const response = new PassThrough() as PassThrough & {
    statusCode: number;
    headers: Record<string, string>;
    resume: () => void;
    destroy: () => void;
    setTimeout: () => void;
  };
  response.statusCode = 200;
  response.headers = { 'content-type': 'image/png', 'content-length': String(bytes.length) };
  response.setTimeout = vi.fn();
  setImmediate(() => response.end(bytes));
  return { response };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.incrementMediaCacheFailCount.mockResolvedValue(1);
  mocks.fetchUpstreamFollowingRedirects.mockImplementation(async () =>
    imageResponse(Buffer.from('\x89PNG\r\n\x1a\nfake-png-bytes')));
});

describe('the cache worker and a spent write budget', () => {
  it('stops the sweep at the first refusal instead of one per entry', async () => {
    const due = Array.from({ length: 12 }, (_, index) => `https://remote.example/${index}.png`);
    mocks.findDueMediaCacheEntries.mockResolvedValue(due);
    mocks.uploadCachedMedia.mockRejectedValue(new ThrottledError('upload'));

    await runCacheWorkerOnce();

    // EXACTLY one concurrency batch attempted, then the sweep returns. An
    // inequality would also pass if the stop landed a batch late, which is the
    // regression this guards.
    expect(mocks.uploadCachedMedia).toHaveBeenCalledTimes(MEDIA_CACHE_WORKER_CONCURRENCY);
    expect(mocks.markMediaCacheCached).not.toHaveBeenCalled();
  });

  it('does not count a refusal against the entry that happened to be queued', async () => {
    mocks.findDueMediaCacheEntries.mockResolvedValue(['https://remote.example/one.png']);
    mocks.uploadCachedMedia.mockRejectedValue(new ThrottledError('upload'));

    await runCacheWorkerOnce();

    // No backoff, no `failed`: the entry is still `pending` and due.
    expect(mocks.incrementMediaCacheFailCount).not.toHaveBeenCalled();
    expect(mocks.markMediaCacheFailed).not.toHaveBeenCalled();
    expect(mocks.scheduleMediaCacheRetry).not.toHaveBeenCalled();
  });

  it('still backs off an ordinary upload failure', async () => {
    mocks.findDueMediaCacheEntries.mockResolvedValue(['https://remote.example/one.png']);
    mocks.uploadCachedMedia.mockRejectedValue(new Error('Oxy media store upload failed (HTTP 500)'));

    await runCacheWorkerOnce();

    // The distinction that matters: a real failure IS this entry's problem.
    expect(mocks.incrementMediaCacheFailCount).toHaveBeenCalledWith('https://remote.example/one.png');
  });

  it('caches normally when the budget is available', async () => {
    mocks.findDueMediaCacheEntries.mockResolvedValue(['https://remote.example/one.png']);
    mocks.uploadCachedMedia.mockResolvedValue({ oxyFileId: 'oxy_file_1', contentType: 'image/png' });

    await runCacheWorkerOnce();

    expect(mocks.markMediaCacheCached).toHaveBeenCalledWith(
      'https://remote.example/one.png',
      expect.objectContaining({ oxyFileId: 'oxy_file_1' }),
    );
  });
});

describe('the eviction sweep and a spent write budget', () => {
  const candidates = Array.from({ length: 10 }, (_, index) => ({
    remoteUrl: `https://remote.example/old-${index}.png`,
    oxyFileId: `oxy_file_${index}`,
    posterFileId: null,
  }));

  it('stops the sweep at the first refusal and leaves the rows cached', async () => {
    mocks.findEvictableMediaCacheEntries.mockResolvedValue(candidates);
    mocks.deleteCachedMedia.mockRejectedValue(new ThrottledError('delete'));

    await runEvictionOnce();

    expect(mocks.deleteCachedMedia).toHaveBeenCalledTimes(MEDIA_CACHE_EVICTION_CONCURRENCY);
    // Never `evicted` while the bytes may still be in S3.
    expect(mocks.markMediaCacheEvicted).not.toHaveBeenCalled();
  });

  it('keeps going past an ordinary delete failure, as before', async () => {
    mocks.findEvictableMediaCacheEntries.mockResolvedValue(candidates.slice(0, 4));
    mocks.deleteCachedMedia.mockRejectedValue(new Error('Oxy media store delete failed (HTTP 500)'));

    await runEvictionOnce();

    // Every candidate was attempted: a 500 on one object says nothing about the
    // next, so the sweep must not treat it as a global stop signal.
    expect(mocks.deleteCachedMedia).toHaveBeenCalledTimes(4);
    expect(mocks.markMediaCacheEvicted).not.toHaveBeenCalled();
  });

  it('evicts normally when the budget is available', async () => {
    mocks.findEvictableMediaCacheEntries.mockResolvedValue(candidates.slice(0, 2));
    mocks.deleteCachedMedia.mockResolvedValue(undefined);

    await runEvictionOnce();

    expect(mocks.markMediaCacheEvicted).toHaveBeenCalledTimes(2);
  });
});
