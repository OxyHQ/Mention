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
const CLOUD_BASE = 'https://cloud.oxy.so';

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
const getCloudURL = vi.fn(() => CLOUD_BASE);

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ getFileDownloadUrl, getBaseURL, getCloudURL }),
}));

import { resolveMediaRef, resolveAvatarUrl, resolveMediaItems } from '../../utils/mediaResolver';

describe('resolveMediaRef', () => {
  beforeEach(() => {
    getFileDownloadUrl.mockClear();
    getBaseURL.mockClear();
  });

  it('resolves an Oxy file id to original url + w320 thumb + w2048 fullUrl', () => {
    const result = resolveMediaRef('file123');

    // `url` is the no-variant original (also the playable source for videos).
    expect(result.url).toBe(`${OXY_BASE}/assets/file123/stream`);
    // Thumbnail uses a display-sized variant, NOT the 256px `thumb` crop.
    // The post media card / profile grid are ≤320px, so this is `w320`.
    expect(result.thumbUrl).toBe(`${OXY_BASE}/assets/file123/stream?variant=w320`);
    // For an image-like asset the poster mirrors the thumbnail.
    expect(result.posterUrl).toBe(result.thumbUrl);
    // The lightbox upgrade uses a large variant, not the raw original.
    expect(result.fullUrl).toBe(`${OXY_BASE}/assets/file123/stream?variant=w2048`);
    expect(getFileDownloadUrl).toHaveBeenCalledWith('file123');
    expect(getFileDownloadUrl).toHaveBeenCalledWith('file123', 'w320');
    expect(getFileDownloadUrl).toHaveBeenCalledWith('file123', 'w2048');
  });

  it('wraps an external http(s) url behind /media/proxy and /media/poster, asking for sized variants', () => {
    const external = 'https://mastodon.social/media/abc.jpg';
    const result = resolveMediaRef(external);

    const encoded = encodeURIComponent(external);
    // `url` is the un-varianted original (and the playable source for a video).
    expect(result.url).toBe(`${PUBLIC_BASE}/media/proxy?url=${encoded}`);
    expect(result.thumbUrl).toBe(`${PUBLIC_BASE}/media/proxy?url=${encoded}&variant=w320`);
    expect(result.posterUrl).toBe(`${PUBLIC_BASE}/media/poster?url=${encoded}`);
    expect(result.fullUrl).toBe(`${PUBLIC_BASE}/media/proxy?url=${encoded}&variant=w2048`);
    // External URLs never touch the Oxy file URL builder.
    expect(getFileDownloadUrl).not.toHaveBeenCalled();
  });

  it('never gives federated media a thumbUrl identical to its full-size url', () => {
    // THE regression this guards: `thumbUrl` used to be the very same
    // un-varianted proxy URL as `url`, so a feed card — which renders `thumbUrl`
    // directly — downloaded the remote ORIGINAL to fill a ≤320px box (measured at
    // 2.5 MB for one Mastodon PNG, 3.9 MB for one Pleroma JPEG). The two URLs
    // being distinct is what lets the proxy tell a thumbnail request from a
    // full-size one at all.
    //
    // Asserted across several origins because the fix must not be tied to any one
    // server's URL conventions: Mastodon exposes a `/small/` sibling of
    // `/original/`, but Pleroma serves its preview at byte-identical bytes to the
    // full image and Bluesky uses an opaque blob endpoint, so nothing may be
    // inferred from the remote path.
    const origins = [
      'https://cdn.masto.host/inst/media_attachments/files/1/2/3/original/abc.png',
      'https://annihilation.social/media/0f1e-2d3c/photo.jpeg?name=photo.jpeg',
      'https://misskey.io/files/9a8b7c6d-1234',
      'https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:abc/xyz@jpeg',
    ];

    for (const origin of origins) {
      const result = resolveMediaRef(origin);
      expect(result.thumbUrl).toBeDefined();
      expect(result.thumbUrl).not.toBe(result.url);
      expect(result.thumbUrl).toContain('variant=w320');
      // The lightbox must still be able to reach the full image.
      expect(result.url).toBe(`${PUBLIC_BASE}/media/proxy?url=${encodeURIComponent(origin)}`);
      expect(result.url).not.toContain('variant=');
    }
  });

  it('keeps the remote url intact inside the proxy variant URLs', () => {
    // The variant is appended as a separate query parameter, so a remote URL that
    // itself carries a query string (Pleroma and Bluesky both do) must survive
    // encoded and unmodified — otherwise the proxy would fetch a different asset.
    const external = 'https://annihilation.social/media/uuid/a%20b.jpg?name=a%20b.jpg';
    const result = resolveMediaRef(external);

    const parsed = new URL(result.thumbUrl as string);
    expect(parsed.searchParams.get('url')).toBe(external);
    expect(parsed.searchParams.get('variant')).toBe('w320');
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
  it('returns the dedicated avatar crop for an Oxy file id', () => {
    // Avatars use the dedicated 96px square `w96` crop (not the wider w320
    // used for post media, nor the 256px `thumb`), since they render tiny and
    // circular.
    expect(resolveAvatarUrl('avatar1')).toBe(`${OXY_BASE}/assets/avatar1/stream?variant=w96`);
  });

  it('returns the proxy url for an external avatar, asking for the avatar variant', () => {
    // An avatar renders tiny and circular, so it asks for `w96` — NOT the `w320`
    // post-media thumbnail `resolveMediaRef` would otherwise hand back.
    const external = 'https://cdn.example.com/avatar.png';
    expect(resolveAvatarUrl(external)).toBe(
      `${PUBLIC_BASE}/media/proxy?url=${encodeURIComponent(external)}&variant=w96`,
    );
  });

  it('proxies a genuinely-external federated avatar host (regression guard)', () => {
    // A truly-remote federated CDN must still be wrapped behind /media/proxy,
    // NOT treated as an Oxy CDN URL.
    const external = 'https://files.mastodon.social/accounts/avatars/original.png';
    expect(resolveAvatarUrl(external)).toBe(
      `${PUBLIC_BASE}/media/proxy?url=${encodeURIComponent(external)}&variant=w96`,
    );
  });

  it('attaches the avatar variant to an already-mirrored Oxy CDN url', () => {
    // A federated avatar Oxy mirrored to its CDN arrives as a final
    // cloud.oxy.so/<id> URL. It must get the avatar variant appended, NOT be
    // served as the no-variant original or double-proxied through /media/proxy.
    const mirrored = `${CLOUD_BASE}/abc123`;
    expect(resolveAvatarUrl(mirrored)).toBe(`${CLOUD_BASE}/abc123?variant=w96`);
  });

  it('is idempotent when the mirrored Oxy CDN url already carries a variant', () => {
    const mirrored = `${CLOUD_BASE}/abc123?variant=w320`;
    expect(resolveAvatarUrl(mirrored)).toBe(`${CLOUD_BASE}/abc123?variant=w96`);
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
    expect(items[0].thumbUrl).toBe(`${OXY_BASE}/assets/file1/stream?variant=w320`);
    expect(items[0].fullUrl).toBe(`${OXY_BASE}/assets/file1/stream?variant=w2048`);

    const encoded = encodeURIComponent('https://external.test/v.mp4');
    expect(items[1].id).toBe('https://external.test/v.mp4');
    expect(items[1].type).toBe('video');
    // The playable source stays un-varianted; the poster keeps its own endpoint.
    expect(items[1].url).toBe(`${PUBLIC_BASE}/media/proxy?url=${encoded}`);
    expect(items[1].posterUrl).toBe(`${PUBLIC_BASE}/media/poster?url=${encoded}`);
    // A federated video's `thumbUrl` is its POSTER, never the proxied video
    // asking for an image variant: `/media/proxy` honours a variant only for
    // image content types, so that URL would hand an <Image> raw video bytes.
    expect(items[1].thumbUrl).toBe(`${PUBLIC_BASE}/media/poster?url=${encoded}`);
    expect(items[1].thumbUrl).not.toContain('/media/proxy');
  });

  it('leaves the Oxy-file branch on its own variants, untouched by the federated fix', () => {
    // Pins that giving FEDERATED media a thumbnail path did not disturb the
    // native one: native items resolve through the SDK's file-URL builder with
    // the `MEDIA_VARIANT_*` taxonomy, and must never acquire a `/media/proxy`
    // URL (which would double-proxy our own CDN).
    const items = resolveMediaItems([
      { id: 'native-img', type: 'image' },
      { id: 'native-vid', type: 'video' },
    ]);

    expect(items[0].url).toBe(`${OXY_BASE}/assets/native-img/stream`);
    expect(items[0].thumbUrl).toBe(`${OXY_BASE}/assets/native-img/stream?variant=w320`);
    expect(items[0].posterUrl).toBe(`${OXY_BASE}/assets/native-img/stream?variant=w320`);
    expect(items[0].fullUrl).toBe(`${OXY_BASE}/assets/native-img/stream?variant=w2048`);

    expect(items[1].thumbUrl).toBe(`${OXY_BASE}/assets/native-vid/stream?variant=w320`);
    expect(items[1].fullUrl).toBeUndefined();

    for (const item of items) {
      for (const url of [item.url, item.thumbUrl, item.posterUrl, item.fullUrl]) {
        expect(url ?? '').not.toContain('/media/proxy');
      }
    }
  });

  it('gives a native video TWO still sizes: a grid-cell thumb and a player poster', () => {
    // The two surfaces differ by an order of magnitude — a ~130px grid cell
    // versus a full-width player — so one size cannot serve both. `thumb`(256)
    // used to serve both and was wrong at each end: 144x256 is soft fullscreen,
    // while the only other working option (the raw 1920px `poster`) is ~6x
    // oversized for a cell.
    const items = resolveMediaItems([{ id: 'video-file', type: 'video' }]);

    expect(items).toHaveLength(1);
    expect(items[0].url).toBe(`${OXY_BASE}/assets/video-file/stream`);
    expect(items[0].thumbUrl).toBe(`${OXY_BASE}/assets/video-file/stream?variant=w320`);
    expect(items[0].posterUrl).toBe(`${OXY_BASE}/assets/video-file/stream?variant=w1280`);
    expect(items[0].thumbUrl).not.toBe(items[0].posterUrl);
    expect(items[0].fullUrl).toBeUndefined();
  });

  it('never asks for a variant name the asset service does not generate', () => {
    // Every name emitted for a video must exist server-side. `thumb` for a video
    // was a hard 404 on the CDN until oxy-api learned to render image sizes from
    // the poster frame, and a name outside the taxonomy (`full`, `large`,
    // `original`) 404s for every mime.
    const generated = new Set([
      'w96', 'w128', 'thumb', 'w320', 'w640', 'w1280', 'w2048', 'poster', 'hls_master',
    ]);
    const items = resolveMediaItems([
      { id: 'video-file', type: 'video' },
      { id: 'img-file', type: 'image' },
    ]);

    for (const item of items) {
      for (const url of [item.url, item.thumbUrl, item.posterUrl, item.fullUrl, item.hlsUrl]) {
        const variant = url ? new URL(url).searchParams.get('variant') : null;
        if (variant) expect(generated).toContain(variant);
      }
    }
  });

  it('resolves the hls_master variant as hlsUrl for a native Oxy video', () => {
    const items = resolveMediaItems([{ id: 'video-file', type: 'video' }]);

    expect(items).toHaveLength(1);
    expect(items[0].hlsUrl).toBe(`${OXY_BASE}/assets/video-file/stream?variant=hls_master`);
    expect(getFileDownloadUrl).toHaveBeenCalledWith('video-file', 'hls_master');
  });

  it('does not populate hlsUrl for a federated (absolute-URL) video item', () => {
    const items = resolveMediaItems([{ id: 'https://external.test/v.mp4', type: 'video' }]);

    expect(items).toHaveLength(1);
    expect(items[0].hlsUrl).toBeUndefined();
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

/**
 * Intrinsic geometry is resolved once at ingest and persisted on the post, but
 * every branch of `resolveMediaItems` builds a FRESH object — so a field that
 * is not deliberately carried across is silently lost, and the client is left
 * to measure the bytes itself and re-lay-out. These cases pin the passthrough
 * on each branch (plain image, video, GIF), since they return from three
 * separate statements and a fix applied to only one would still regress the
 * others.
 */
describe('resolveMediaItems — persisted geometry passthrough', () => {
  const geometry = {
    width: 1200,
    height: 800,
    aspectRatio: 1.5,
    orientation: 'landscape',
  } as const;

  it('forwards width/height/aspectRatio/orientation for a native image', () => {
    const [item] = resolveMediaItems([{ id: 'img-file', type: 'image', ...geometry }]);

    expect(item).toMatchObject(geometry);
    // The URLs must still be resolved, not displaced by the geometry spread.
    expect(item.thumbUrl).toBe(`${OXY_BASE}/assets/img-file/stream?variant=w320`);
  });

  it('forwards geometry and durationSec for a video', () => {
    const [item] = resolveMediaItems([
      { id: 'video-file', type: 'video', ...geometry, durationSec: 12.5 },
    ]);

    expect(item).toMatchObject({ ...geometry, durationSec: 12.5 });
    expect(item.posterUrl).toBe(`${OXY_BASE}/assets/video-file/stream?variant=w1280`);
  });

  it('forwards geometry for a GIF', () => {
    const [item] = resolveMediaItems([{ id: 'gif-file', type: 'gif', ...geometry }]);

    expect(item).toMatchObject(geometry);
  });

  it('forwards geometry for federated (absolute-URL) media', () => {
    const [item] = resolveMediaItems([
      { id: 'https://external.test/i.png', type: 'image', ...geometry },
    ]);

    expect(item).toMatchObject(geometry);
  });

  it('omits geometry keys entirely when the item has none', () => {
    const [item] = resolveMediaItems([{ id: 'bare', type: 'image' }]);

    expect(item).not.toHaveProperty('width');
    expect(item).not.toHaveProperty('height');
    expect(item).not.toHaveProperty('aspectRatio');
    expect(item).not.toHaveProperty('orientation');
    expect(item).not.toHaveProperty('durationSec');
  });

  // The other side of the same property. Because every return site builds a
  // fresh object, the fields listed there ARE the public shape of a media cell —
  // which is how the geometry above went missing from the DTO for three weeks
  // while ingest kept storing it. That cuts both ways: the omission of these
  // fields is a deliberate boundary, not another oversight, so it is pinned
  // rather than left to be re-derived by whoever next widens the list.
  it('keeps ingest-only bookkeeping server-side', () => {
    const [item] = resolveMediaItems([
      {
        id: 'internal',
        type: 'image',
        ...geometry,
        sizeBytes: 12345,
        mime: 'image/jpeg',
        remoteUrl: 'https://remote.test/original.jpg',
        cachedFromFederation: true,
      },
    ]);

    expect(item).toMatchObject(geometry);
    expect(item).not.toHaveProperty('sizeBytes');
    expect(item).not.toHaveProperty('mime');
    // A federated item's ORIGIN url is the one that must never leak: the DTO
    // deliberately hands out our proxied url instead.
    expect(item).not.toHaveProperty('remoteUrl');
    expect(item).not.toHaveProperty('cachedFromFederation');
  });
});
