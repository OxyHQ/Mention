import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MediaItem } from '@mention/shared-types';

const findById = vi.fn();
const updateOne = vi.fn();
const enrichFromOxy = vi.fn();
const needsOxyRetry = vi.fn();

vi.mock('../../models/Post', () => ({
  Post: {
    findById: (...args: unknown[]) => findById(...args),
    updateOne: (...args: unknown[]) => updateOne(...args),
  },
}));

vi.mock('../../services/MediaMetadataService', () => ({
  mediaMetadataService: {
    enrichFromOxy: (...args: unknown[]) => enrichFromOxy(...args),
    needsOxyRetry: (...args: unknown[]) => needsOxyRetry(...args),
  },
}));

vi.mock('../../queue/producers', () => ({
  enqueueMediaMetadataEnrich: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  processMediaMetadataEnrichJob,
  patchPostMediaMetadata,
  MediaMetadataPendingError,
} from '../../services/mediaMetadataEnrichJob';

const OXY_ID = '65fdc8c8c8c8c8c8c8c8c8c8';
const POST_ID = '65aaaaaaaaaaaaaaaaaaaaaa';

/** A mirrored federated video whose Oxy probe has not landed yet. */
const pendingVideo: MediaItem = { id: OXY_ID, type: 'video' };
/** The same item once Oxy has derived its intrinsics. */
const probedVideo: MediaItem = {
  id: OXY_ID,
  type: 'video',
  width: 720,
  height: 1280,
  durationSec: 117.017,
  orientation: 'portrait',
  aspectRatio: 0.5625,
};

function mockPostWithMedia(media: MediaItem[]): void {
  findById.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve({ content: { media } }) }),
  });
}

describe('processMediaMetadataEnrichJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateOne.mockResolvedValue({ acknowledged: true });
  });

  it('THROWS while Oxy metadata is still pending, so BullMQ actually retries', async () => {
    // The load-bearing assertion. BullMQ only re-runs a job that throws: a
    // handler returning normally consumes its single delivery and leaves the
    // queue's `attempts`/`backoff` inert. Returning here is what the handler used
    // to do, which is why federated video never acquired a duration.
    mockPostWithMedia([pendingVideo]);
    enrichFromOxy.mockResolvedValue([pendingVideo]);
    needsOxyRetry.mockReturnValue(true);

    await expect(processMediaMetadataEnrichJob(POST_ID)).rejects.toThrow(MediaMetadataPendingError);
    await expect(processMediaMetadataEnrichJob(POST_ID)).rejects.toThrow(/still pending/i);
  });

  it('resolves without throwing once Oxy has derived the metadata', async () => {
    mockPostWithMedia([pendingVideo]);
    enrichFromOxy.mockResolvedValue([probedVideo]);
    needsOxyRetry.mockReturnValue(false);

    await expect(processMediaMetadataEnrichJob(POST_ID)).resolves.toBeUndefined();
    expect(updateOne).toHaveBeenCalledTimes(1);
  });

  it('persists the enriched media when Oxy returns new intrinsics', async () => {
    mockPostWithMedia([pendingVideo]);
    enrichFromOxy.mockResolvedValue([probedVideo]);
    needsOxyRetry.mockReturnValue(false);

    await patchPostMediaMetadata(POST_ID);

    expect(updateOne).toHaveBeenCalledWith(
      { _id: POST_ID },
      { $set: { 'content.media': [probedVideo] } },
    );
  });

  it('does not write when nothing changed', async () => {
    mockPostWithMedia([probedVideo]);
    enrichFromOxy.mockResolvedValue([probedVideo]);
    needsOxyRetry.mockReturnValue(false);

    await patchPostMediaMetadata(POST_ID);

    expect(updateOne).not.toHaveBeenCalled();
  });

  it('propagates a genuine patch failure rather than reporting it as pending', async () => {
    mockPostWithMedia([pendingVideo]);
    enrichFromOxy.mockRejectedValue(new Error('oxy unreachable'));

    await expect(processMediaMetadataEnrichJob(POST_ID)).rejects.toThrow('oxy unreachable');
    // A transport failure must NOT be relabelled as a pending probe — the two
    // have different causes and the pending path must stay attributable.
    await expect(processMediaMetadataEnrichJob(POST_ID)).rejects.not.toThrow(MediaMetadataPendingError);
  });

  it('is a no-op for a post with no media', async () => {
    findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ content: {} }) }) });

    await expect(processMediaMetadataEnrichJob(POST_ID)).resolves.toBeUndefined();
    expect(enrichFromOxy).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('is a no-op for a post that no longer exists', async () => {
    findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) });

    await expect(processMediaMetadataEnrichJob(POST_ID)).resolves.toBeUndefined();
    expect(enrichFromOxy).not.toHaveBeenCalled();
  });
});
