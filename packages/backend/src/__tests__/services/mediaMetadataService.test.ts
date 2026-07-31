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

  it('isOxyFileId accepts 24-char hex ids', () => {
    expect(isOxyFileId('65fdc8c8c8c8c8c8c8c8c8c8')).toBe(true);
    expect(isOxyFileId('https://example.com/video.mp4')).toBe(false);
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
});
