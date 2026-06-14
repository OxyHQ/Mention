import { describe, it, expect } from 'vitest';
import {
  classifyFailure,
  decideProxyServe,
  isCacheableMediaType,
  isVideoType,
  maxBytesForType,
  type CacheLookup,
} from '../../services/mediaCache/policy';
import {
  MEDIA_CACHE_BACKOFF_BASE_MS,
  MEDIA_CACHE_BACKOFF_MAX_MS,
  MEDIA_CACHE_MAX_FAIL_COUNT,
  MEDIA_CACHE_MAX_IMAGE_BYTES,
  MEDIA_CACHE_MAX_VIDEO_BYTES,
} from '../../services/mediaCache/constants';

describe('media cache policy — decideProxyServe (state machine)', () => {
  it('miss (no row) → stream from remote AND enqueue a first cache attempt', () => {
    expect(decideProxyServe(undefined)).toEqual({ action: 'stream-and-enqueue' });
  });

  it('cached WITH oxyFileId → serve from Oxy', () => {
    const row: CacheLookup = { state: 'cached', oxyFileId: 'file_123' };
    expect(decideProxyServe(row)).toEqual({ action: 'serve-from-oxy', oxyFileId: 'file_123' });
  });

  it('cached WITHOUT oxyFileId (inconsistent) → treat as miss, re-enqueue', () => {
    const row: CacheLookup = { state: 'cached' };
    expect(decideProxyServe(row)).toEqual({ action: 'stream-and-enqueue' });
  });

  it('pending (in flight) → stream from remote, do NOT double-enqueue', () => {
    const row: CacheLookup = { state: 'pending' };
    expect(decideProxyServe(row)).toEqual({ action: 'stream-only' });
  });

  it('evicted → stream from remote AND re-enqueue (re-cache on access)', () => {
    const row: CacheLookup = { state: 'evicted' };
    expect(decideProxyServe(row)).toEqual({ action: 'stream-and-enqueue' });
  });

  it('failed → stream from remote only (caching gave up)', () => {
    const row: CacheLookup = { state: 'failed' };
    expect(decideProxyServe(row)).toEqual({ action: 'stream-only' });
  });

  it('full lifecycle: miss → pending → cached → evicted → re-cache', () => {
    // miss → enqueue (becomes pending)
    expect(decideProxyServe(undefined).action).toBe('stream-and-enqueue');
    // pending → stream only while worker runs
    expect(decideProxyServe({ state: 'pending' }).action).toBe('stream-only');
    // cached → serve from Oxy
    expect(decideProxyServe({ state: 'cached', oxyFileId: 'f' }).action).toBe('serve-from-oxy');
    // evicted → re-enqueue (back to pending on next access)
    expect(decideProxyServe({ state: 'evicted' }).action).toBe('stream-and-enqueue');
  });
});

describe('media cache policy — content type gating', () => {
  it('accepts image/video/audio families', () => {
    expect(isCacheableMediaType('image/jpeg')).toBe(true);
    expect(isCacheableMediaType('video/mp4')).toBe(true);
    expect(isCacheableMediaType('audio/mpeg')).toBe(true);
    expect(isCacheableMediaType('IMAGE/PNG; charset=binary')).toBe(true);
  });

  it('rejects SVG (XSS vector) and non-media types', () => {
    expect(isCacheableMediaType('image/svg+xml')).toBe(false);
    expect(isCacheableMediaType('text/html')).toBe(false);
    expect(isCacheableMediaType('application/json')).toBe(false);
    expect(isCacheableMediaType('')).toBe(false);
  });

  it('detects video for poster extraction', () => {
    expect(isVideoType('video/mp4')).toBe(true);
    expect(isVideoType('video/webm; codecs="vp9"')).toBe(true);
    expect(isVideoType('image/jpeg')).toBe(false);
  });

  it('applies a larger size cap to video than image/audio', () => {
    expect(maxBytesForType('video/mp4')).toBe(MEDIA_CACHE_MAX_VIDEO_BYTES);
    expect(maxBytesForType('image/jpeg')).toBe(MEDIA_CACHE_MAX_IMAGE_BYTES);
    expect(maxBytesForType('audio/mpeg')).toBe(MEDIA_CACHE_MAX_IMAGE_BYTES);
    expect(MEDIA_CACHE_MAX_VIDEO_BYTES).toBeGreaterThan(MEDIA_CACHE_MAX_IMAGE_BYTES);
  });
});

describe('media cache policy — failure backoff', () => {
  it('first failure schedules the base backoff, not a give-up', () => {
    const outcome = classifyFailure(1);
    expect(outcome.giveUp).toBe(false);
    if (!outcome.giveUp) {
      expect(outcome.nextAttemptInMs).toBe(MEDIA_CACHE_BACKOFF_BASE_MS);
    }
  });

  it('backoff grows exponentially with each failure', () => {
    const first = classifyFailure(1);
    const second = classifyFailure(2);
    const third = classifyFailure(3);
    if (!first.giveUp && !second.giveUp && !third.giveUp) {
      expect(second.nextAttemptInMs).toBe(first.nextAttemptInMs * 2);
      expect(third.nextAttemptInMs).toBe(first.nextAttemptInMs * 4);
    } else {
      throw new Error('expected pre-cap failures to schedule a backoff');
    }
  });

  it('backoff never exceeds the cap', () => {
    const outcome = classifyFailure(MEDIA_CACHE_MAX_FAIL_COUNT - 1);
    if (!outcome.giveUp) {
      expect(outcome.nextAttemptInMs).toBeLessThanOrEqual(MEDIA_CACHE_BACKOFF_MAX_MS);
    }
  });

  it('gives up once the max fail count is reached', () => {
    expect(classifyFailure(MEDIA_CACHE_MAX_FAIL_COUNT)).toEqual({ giveUp: true });
    expect(classifyFailure(MEDIA_CACHE_MAX_FAIL_COUNT + 1)).toEqual({ giveUp: true });
  });
});
