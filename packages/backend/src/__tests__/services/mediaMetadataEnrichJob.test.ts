import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { PostType, PostVisibility, type MediaItem } from '@mention/shared-types';

/**
 * The media-metadata retry job, against REAL ROWS.
 *
 * The previous version stubbed `Post.findById(...).select().lean()` and
 * `Post.updateOne`, and asserted the dotted `$set` the job passed. That is the
 * one thing the port could not preserve: `content.media` is a CHILD TABLE with a
 * dense `UNIQUE (post_id, position)`, so the write is a transactional
 * delete-then-insert and there is no `$set` path to assert. What matters is what
 * the row says AFTERWARDS — the gallery's order and each item's intrinsics — so
 * every assertion below reads the stored media back.
 *
 * Oxy's probe is still stubbed: it is a network call, and the behaviour under
 * test is what the job does with its answer.
 */
const enrichFromOxy = vi.fn();
const needsOxyRetry = vi.fn();

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

import { closePostgres, connectPostgres } from '../../db/postgres';
import { deletePostRecord, insertPostRecord, loadPostRecord } from '../../db/posts/postRepository';
import {
  processMediaMetadataEnrichJob,
  patchPostMediaMetadata,
  MediaMetadataPendingError,
} from '../../services/mediaMetadataEnrichJob';

const OXY_ID = '65fdc8c8c8c8c8c8c8c8c8c8';
const AUTHOR = 'oxy-media-author';
const created: string[] = [];

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

async function seedPostWithMedia(media: MediaItem[]): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: media.length > 0 ? PostType.VIDEO : PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: {
      variants: [{ source: 'author', text: 'a clip', tag: 'en' }],
      ...(media.length > 0 ? { media } : {}),
    },
  });
  created.push(record.id);
  return record.id;
}

async function storedMedia(postId: string): Promise<MediaItem[]> {
  const record = await loadPostRecord(postId);
  return record?.content.media ?? [];
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const id of created.splice(0).reverse()) {
    await deletePostRecord(id, undefined);
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('processMediaMetadataEnrichJob', () => {
  it('THROWS while Oxy metadata is still pending, so BullMQ actually retries', async () => {
    // The load-bearing assertion. BullMQ only re-runs a job that throws: a
    // handler returning normally consumes its single delivery and leaves the
    // queue's `attempts`/`backoff` inert. Returning here is what the handler used
    // to do, which is why federated video never acquired a duration.
    const postId = await seedPostWithMedia([pendingVideo]);
    enrichFromOxy.mockResolvedValue([pendingVideo]);
    needsOxyRetry.mockReturnValue(true);

    await expect(processMediaMetadataEnrichJob(postId)).rejects.toThrow(MediaMetadataPendingError);
    await expect(processMediaMetadataEnrichJob(postId)).rejects.toThrow(/still pending/i);
  });

  it('resolves without throwing once Oxy has derived the metadata', async () => {
    const postId = await seedPostWithMedia([pendingVideo]);
    enrichFromOxy.mockResolvedValue([probedVideo]);
    needsOxyRetry.mockReturnValue(false);

    await expect(processMediaMetadataEnrichJob(postId)).resolves.toBeUndefined();
    expect(await storedMedia(postId)).toEqual([probedVideo]);
  });

  it('persists the enriched intrinsics onto the stored media row', async () => {
    const postId = await seedPostWithMedia([pendingVideo]);
    enrichFromOxy.mockResolvedValue([probedVideo]);
    needsOxyRetry.mockReturnValue(false);

    await patchPostMediaMetadata(postId);

    expect(await storedMedia(postId)).toEqual([probedVideo]);
  });

  it('keeps the gallery ORDER when it rewrites the media rows', async () => {
    // The child table carries a dense `position`, and the write is a
    // delete-then-insert of the whole set — so an enrichment that reordered the
    // gallery would silently rearrange what the author arranged.
    const first: MediaItem = { id: 'media-a', type: 'image' };
    const second: MediaItem = { id: 'media-b', type: 'image' };
    const third: MediaItem = { id: 'media-c', type: 'image' };
    const postId = await seedPostWithMedia([first, second, third]);
    enrichFromOxy.mockResolvedValue([
      { ...first, width: 10, height: 10 },
      { ...second, width: 20, height: 20 },
      { ...third, width: 30, height: 30 },
    ]);
    needsOxyRetry.mockReturnValue(false);

    await patchPostMediaMetadata(postId);

    expect((await storedMedia(postId)).map((item) => item.id)).toEqual([
      'media-a',
      'media-b',
      'media-c',
    ]);
  });

  it('does not write when nothing changed', async () => {
    const postId = await seedPostWithMedia([probedVideo]);
    enrichFromOxy.mockResolvedValue([probedVideo]);
    needsOxyRetry.mockReturnValue(false);

    await patchPostMediaMetadata(postId);

    expect(await storedMedia(postId)).toEqual([probedVideo]);
  });

  it('propagates a genuine patch failure rather than reporting it as pending', async () => {
    const postId = await seedPostWithMedia([pendingVideo]);
    enrichFromOxy.mockRejectedValue(new Error('oxy unreachable'));

    await expect(processMediaMetadataEnrichJob(postId)).rejects.toThrow('oxy unreachable');
    // A transport failure must NOT be relabelled as a pending probe — the two
    // have different causes and the pending path must stay attributable.
    await expect(processMediaMetadataEnrichJob(postId)).rejects.not.toThrow(MediaMetadataPendingError);
  });

  it('is a no-op for a post with no media', async () => {
    const postId = await seedPostWithMedia([]);

    await expect(processMediaMetadataEnrichJob(postId)).resolves.toBeUndefined();
    expect(enrichFromOxy).not.toHaveBeenCalled();
  });

  it('is a no-op for a post that no longer exists', async () => {
    await expect(processMediaMetadataEnrichJob('gone-for-good')).resolves.toBeUndefined();
    expect(enrichFromOxy).not.toHaveBeenCalled();
  });
});
