import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MediaItem } from '@mention/shared-types';
import {
  mergeMediaItem,
  patchFromApAttachment,
  readPersistedMediaFields,
  isOxyFileId,
} from '../../services/MediaMetadataService';

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: vi.fn(),
}));

describe('MediaMetadataService helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The whole point of the discriminator, stated as the question it asks: is
  // this a URL? Anything else is an id and gets asked about. The uuid v7 case is
  // the one that regressed — oxy-api's file ids have been uuid v7 since its
  // 2026-07-31 Postgres cutover, and a `/^[a-f0-9]{24}$/` test answered `false`
  // for every asset uploaded since, which silently disabled metadata enrichment
  // and, through the Videos lane's `width > 0 AND height > 0`, hid those videos.
  it('isOxyFileId accepts every id shape and rejects only http(s) URLs', () => {
    expect(isOxyFileId('65fdc8c8c8c8c8c8c8c8c8c8')).toBe(true);
    expect(isOxyFileId('01a0821e-d61a-7a78-b5d1-afb1850bd5a4')).toBe(true);
    expect(isOxyFileId('https://example.com/video.mp4')).toBe(false);
    expect(isOxyFileId('http://example.com/video.mp4')).toBe(false);
    expect(isOxyFileId('HTTPS://EXAMPLE.COM/video.mp4')).toBe(false);
    // Not an id and not a URL: a blank ref resolves to an empty media URL, so it
    // must not be sent to a batch lookup as an empty id.
    expect(isOxyFileId('')).toBe(false);
    expect(isOxyFileId('   ')).toBe(false);
  });

  it('readPersistedMediaFields copies stored intrinsic fields', () => {
    const fields = readPersistedMediaFields({
      width: 1080,
      height: 1920,
      durationSec: 42.5,
      orientation: 'portrait',
      aspectRatio: 0.5625,
      alt: '  caption  ',
    });
    expect(fields).toEqual({
      width: 1080,
      height: 1920,
      durationSec: 42.5,
      orientation: 'portrait',
      aspectRatio: 0.5625,
      alt: 'caption',
    });
  });

  it('patchFromApAttachment maps AP dims, duration, alt, and orientation', () => {
    const patch = patchFromApAttachment({
      width: 720,
      height: 1280,
      duration: 33,
      name: 'Scene description',
    });
    expect(patch.width).toBe(720);
    expect(patch.height).toBe(1280);
    expect(patch.durationSec).toBe(33);
    expect(patch.alt).toBe('Scene description');
    expect(patch.orientation).toBe('portrait');
    expect(patch.aspectRatio).toBeCloseTo(720 / 1280);
  });

  it('patchFromApAttachment normalizes alt text to a single line', () => {
    // A federated `attachment.name` is remote text: it carries the whitespace of
    // the remote markup, and a `.trim()` alone leaves the newline INSIDE it —
    // which the client renders verbatim (`white-space: pre-wrap`).
    const patch = patchFromApAttachment({ name: '  Un gato\n  en una caja  ' });
    expect(patch.alt).toBe('Un gato en una caja');
  });

  it('patchFromApAttachment omits a whitespace-only alt', () => {
    expect(patchFromApAttachment({ name: '  \n  ' }).alt).toBeUndefined();
  });

  it('readPersistedMediaFields normalizes a stored multi-line alt', () => {
    expect(readPersistedMediaFields({ alt: 'linea\n\nuno' }).alt).toBe('linea uno');
  });

  it('mergeMediaItem preserves author alt when patch omits it', () => {
    const base: MediaItem = { id: 'abc', type: 'image', alt: 'keep me' };
    const merged = mergeMediaItem(base, { width: 100, height: 200 });
    expect(merged.alt).toBe('keep me');
    expect(merged.width).toBe(100);
  });

  it('mergeMediaItem normalizes the alt it takes from a patch', () => {
    const base: MediaItem = { id: 'abc', type: 'image', alt: 'old' };
    expect(mergeMediaItem(base, { alt: '  nueva\n  descripción ' }).alt).toBe('nueva descripción');
    // A whitespace-only patch alt does not overwrite a real one.
    expect(mergeMediaItem(base, { alt: '   ' }).alt).toBe('old');
  });
});

describe('MediaMetadataService.enrichFromOxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('copies Oxy by-ids fields onto matching media items', async () => {
    const { getServiceOxyClient } = await import('../../utils/oxyHelpers');
    const getServiceAssetMetadataByIds = vi.fn().mockResolvedValue([
      {
        id: '65fdc8c8c8c8c8c8c8c8c8c8',
        width: 1080,
        height: 1920,
        durationSec: 25,
        orientation: 'portrait',
        aspectRatio: 0.5625,
        size: 12345,
      },
    ]);
    vi.mocked(getServiceOxyClient).mockReturnValue({
      getServiceAssetMetadataByIds,
    } as never);

    const { mediaMetadataService } = await import('../../services/MediaMetadataService');
    const items: MediaItem[] = [{ id: '65fdc8c8c8c8c8c8c8c8c8c8', type: 'video' }];
    const enriched = await mediaMetadataService.enrichFromOxy(items);

    expect(enriched[0]).toMatchObject({
      width: 1080,
      height: 1920,
      durationSec: 25,
      orientation: 'portrait',
      aspectRatio: 0.5625,
      sizeBytes: 12345,
    });
  });

  /**
   * The regression that made this file worth reopening, exercised end to end
   * rather than through the predicate: a modern Oxy id must reach the by-ids
   * call and come back enriched. Asserting the ARGUMENT matters as much as the
   * result — the failure was not a wrong value but an empty request, and an
   * enrich that asks about nothing returns the items unchanged and logs nothing.
   */
  it('enriches an asset whose id is a uuid v7 (post-cutover Oxy ids)', async () => {
    const fileId = '01a0821e-d61a-7a78-b5d1-afb1850bd5a4';
    const { getServiceOxyClient } = await import('../../utils/oxyHelpers');
    const getServiceAssetMetadataByIds = vi.fn().mockResolvedValue([
      { id: fileId, width: 720, height: 1280, durationSec: 12, orientation: 'portrait' },
    ]);
    vi.mocked(getServiceOxyClient).mockReturnValue({
      getServiceAssetMetadataByIds,
    } as never);

    const { mediaMetadataService } = await import('../../services/MediaMetadataService');
    const enriched = await mediaMetadataService.enrichFromOxy([{ id: fileId, type: 'video' }]);

    expect(getServiceAssetMetadataByIds).toHaveBeenCalledWith([fileId]);
    expect(enriched[0]).toMatchObject({ width: 720, height: 1280, durationSec: 12 });
  });

  /**
   * The other half of the discriminator: a federated item the media cache never
   * mirrored still holds its ORIGIN URL in `id`, and Oxy has nothing to say about
   * it. Widening the predicate must not turn those into a batch of nonsense ids.
   */
  it('never asks Oxy about a media item whose id is a remote URL', async () => {
    const { getServiceOxyClient } = await import('../../utils/oxyHelpers');
    const getServiceAssetMetadataByIds = vi.fn().mockResolvedValue([]);
    vi.mocked(getServiceOxyClient).mockReturnValue({
      getServiceAssetMetadataByIds,
    } as never);

    const { mediaMetadataService } = await import('../../services/MediaMetadataService');
    const items: MediaItem[] = [{ id: 'https://remote.example/video.mp4', type: 'video' }];

    expect(await mediaMetadataService.enrichFromOxy(items)).toBe(items);
    expect(getServiceAssetMetadataByIds).not.toHaveBeenCalled();
  });

  /**
   * `needsOxyRetry` is what re-queues the BullMQ job while Oxy's ffprobe is still
   * running. It shares the discriminator, so it failed the same way and just as
   * quietly: "nothing pending" for every modern upload, which retired the retry
   * that the whole job exists for.
   */
  it('reports a pending retry for a uuid v7 video with no dimensions yet', async () => {
    const { mediaMetadataService } = await import('../../services/MediaMetadataService');
    const pending: MediaItem[] = [{ id: '01a0821e-d61a-7a78-b5d1-afb1850bd5a4', type: 'video' }];

    expect(mediaMetadataService.needsOxyRetry(pending)).toBe(true);
    expect(
      mediaMetadataService.needsOxyRetry([{ ...pending[0], width: 720, height: 1280, durationSec: 12 }]),
    ).toBe(false);
  });
});
