import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Verifies the single server-authoritative media URL resolver:
 *  - Oxy file id → CDN/stream URL + `thumb` variant thumbnail.
 *  - external http(s) → wrapped behind our `/media/proxy` (url + thumb) and
 *    `/media/poster` (posterUrl).
 *  - own-origin http(s) (backend public URL or Oxy API origin) → passthrough.
 *  - empty/falsy → empty url.
 *
 * The Oxy client is mocked so `getFileDownloadUrl` is pure URL construction and
 * `getBaseURL` provides the Oxy origin used for the own-host check.
 */

const PUBLIC_BASE = 'https://api.mention.earth';
const OXY_BASE = 'https://api.oxy.so';

// Pin the backend public origin deterministically. The real `config` reads
// `MENTION_PUBLIC_API_URL` once at module load, so mocking the module avoids any
// cross-test env-timing flakiness while still exercising `config.publicApiUrl`.
// The literal must be inlined: `vi.mock` is hoisted above local `const`s.
vi.mock('../../config', () => ({
  config: { publicApiUrl: 'https://api.mention.earth' },
}));

const getFileDownloadUrl = vi.fn((fileId: string, variant?: string) => {
  const qs = variant ? `?variant=${variant}` : '';
  return `${OXY_BASE}/assets/${encodeURIComponent(fileId)}/stream${qs}`;
});
const getBaseURL = vi.fn(() => OXY_BASE);

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ getFileDownloadUrl, getBaseURL }),
}));

import { resolveMediaRef, resolveAvatarUrl, resolveMediaItems } from '../../utils/mediaResolver';

describe('resolveMediaRef', () => {
  beforeEach(() => {
    getFileDownloadUrl.mockClear();
    getBaseURL.mockClear();
  });

  it('resolves an Oxy file id to a CDN stream url + thumb thumbUrl', () => {
    const result = resolveMediaRef('file123');

    expect(result.url).toBe(`${OXY_BASE}/assets/file123/stream`);
    expect(result.thumbUrl).toBe(`${OXY_BASE}/assets/file123/stream?variant=thumb`);
    // For an image-like asset the poster mirrors the thumbnail.
    expect(result.posterUrl).toBe(result.thumbUrl);
    expect(getFileDownloadUrl).toHaveBeenCalledWith('file123');
    expect(getFileDownloadUrl).toHaveBeenCalledWith('file123', 'thumb');
  });

  it('wraps an external http(s) url behind /media/proxy and /media/poster', () => {
    const external = 'https://mastodon.social/media/abc.jpg';
    const result = resolveMediaRef(external);

    const encoded = encodeURIComponent(external);
    expect(result.url).toBe(`${PUBLIC_BASE}/media/proxy?url=${encoded}`);
    expect(result.thumbUrl).toBe(`${PUBLIC_BASE}/media/proxy?url=${encoded}`);
    expect(result.posterUrl).toBe(`${PUBLIC_BASE}/media/poster?url=${encoded}`);
    // External URLs never touch the Oxy file URL builder.
    expect(getFileDownloadUrl).not.toHaveBeenCalled();
  });

  it('passes through a URL already on our backend public origin', () => {
    const own = `${PUBLIC_BASE}/media/proxy?url=https%3A%2F%2Fexample.com%2Fa.png`;
    const result = resolveMediaRef(own);

    expect(result.url).toBe(own);
    expect(result.thumbUrl).toBeUndefined();
    expect(result.posterUrl).toBeUndefined();
  });

  it('passes through a URL already on the Oxy API origin', () => {
    const own = `${OXY_BASE}/assets/file999/stream?variant=thumb`;
    const result = resolveMediaRef(own);

    expect(result.url).toBe(own);
    expect(result.thumbUrl).toBeUndefined();
    expect(result.posterUrl).toBeUndefined();
  });

  it('returns an empty url for falsy refs', () => {
    expect(resolveMediaRef('').url).toBe('');
    expect(resolveMediaRef(undefined).url).toBe('');
    expect(resolveMediaRef(null).url).toBe('');
  });
});

describe('resolveAvatarUrl', () => {
  it('returns the thumb variant for an Oxy file id', () => {
    expect(resolveAvatarUrl('avatar1')).toBe(`${OXY_BASE}/assets/avatar1/stream?variant=thumb`);
  });

  it('returns the proxy url for an external avatar', () => {
    const external = 'https://cdn.example.com/avatar.png';
    expect(resolveAvatarUrl(external)).toBe(
      `${PUBLIC_BASE}/media/proxy?url=${encodeURIComponent(external)}`,
    );
  });

  it('returns undefined for an empty ref', () => {
    expect(resolveAvatarUrl('')).toBeUndefined();
    expect(resolveAvatarUrl(undefined)).toBeUndefined();
    expect(resolveAvatarUrl(null)).toBeUndefined();
  });
});

describe('resolveMediaItems', () => {
  it('enriches each item while preserving id and type', () => {
    const items = resolveMediaItems([
      { id: 'file1', type: 'image' },
      { id: 'https://external.test/v.mp4', type: 'video' },
    ]);

    expect(items).toHaveLength(2);

    expect(items[0].id).toBe('file1');
    expect(items[0].type).toBe('image');
    expect(items[0].url).toBe(`${OXY_BASE}/assets/file1/stream`);
    expect(items[0].thumbUrl).toBe(`${OXY_BASE}/assets/file1/stream?variant=thumb`);

    const encoded = encodeURIComponent('https://external.test/v.mp4');
    expect(items[1].id).toBe('https://external.test/v.mp4');
    expect(items[1].type).toBe('video');
    expect(items[1].url).toBe(`${PUBLIC_BASE}/media/proxy?url=${encoded}`);
    expect(items[1].posterUrl).toBe(`${PUBLIC_BASE}/media/poster?url=${encoded}`);
  });

  it('drops items without an id and tolerates empty input', () => {
    expect(resolveMediaItems([])).toEqual([]);
    expect(resolveMediaItems(undefined)).toEqual([]);
    const partial = resolveMediaItems([
      { id: '', type: 'image' },
      { id: 'keep', type: 'image' },
    ]);
    expect(partial).toHaveLength(1);
    expect(partial[0].id).toBe('keep');
  });
});
