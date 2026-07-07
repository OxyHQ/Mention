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

  it('mergeMediaItem preserves author alt when patch omits it', () => {
    const base: MediaItem = { id: 'abc', type: 'image', alt: 'keep me' };
    const merged = mergeMediaItem(base, { width: 100, height: 200 });
    expect(merged.alt).toBe('keep me');
    expect(merged.width).toBe(100);
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
