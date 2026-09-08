/**
 * The media-metadata repair, against real rows — and specifically the agreement
 * between its SQL candidate filter and its JS predicate.
 *
 * The script hydrates a post's whole content graph to decide whether its media
 * needs enriching. Hydrating every post that carries media was affordable when
 * the backlog was small; it is not now, and it is not merely slow: the sweep has
 * no persisted cursor, so a run stopped at its container time bound restarts at
 * the top of `posts.id` order and re-hydrates the same repaired prefix forever.
 * The candidate `EXISTS` is what makes a repaired post LEAVE the set.
 *
 * That turns `mediaNeedsEnrichment` into a rule expressed TWICE — once in SQL to
 * choose what to hydrate, once in TypeScript to decide. A narrower SQL arm skips
 * rows the authority would have repaired, and nothing downstream would ever say
 * so: the counters would report a clean sweep over a set that quietly excluded
 * them. So each arm gets a fixture here, and the assertion is on `scanned` —
 * what the SQL chose — as well as on `updated`.
 *
 * The Oxy client is stubbed to answer for the file ids these fixtures use, so
 * the test exercises selection and writing rather than the network.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

const getServiceAssetMetadataByIds = vi.fn();
vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ getServiceAssetMetadataByIds }),
}));

import { closePostgres, connectPostgres, getDb, type Database } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { postMedia } from '../../db/schema/postContent';
import { insertPostRecord } from '../../db/posts/postRepository';
import { backfillMediaMetadata } from '../../scripts/backfillMediaMetadata';

let db: Database;
const created: string[] = [];

const AUTHOR = 'oxy-mediameta-backfill-author';

/** A post-cutover Oxy file id. The shape the enrichment must recognise. */
const UUID_FILE_ID = '01a0821e-d61a-7a78-b5d1-afb1850bd5a4';
/** A pre-cutover Oxy file id. Still live, still enrichable. */
const HEX_FILE_ID = '65fdc8c8c8c8c8c8c8c8c8c8';
/** Federated media the cache never mirrored: its `id` IS its origin URL. */
const REMOTE_URL = 'https://remote.example/clip.mp4';

async function seedWithMedia(media: Record<string, unknown>[]): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: {
      variants: [{ source: 'author', text: 'a post with media', tag: 'en' }],
      media: media as never,
    },
  });
  created.push(record.id);
  return record.id;
}

async function mediaOf(postId: string) {
  return db
    .select({
      mediaId: postMedia.mediaId,
      width: postMedia.width,
      height: postMedia.height,
      durationSec: postMedia.durationSec,
      orientation: postMedia.orientation,
    })
    .from(postMedia)
    .where(eq(postMedia.postId, postId));
}

beforeAll(async () => {
  db = await connectPostgres();
});

beforeEach(() => {
  getServiceAssetMetadataByIds.mockReset();
  getServiceAssetMetadataByIds.mockImplementation(async (ids: string[]) =>
    ids.map((id) => ({
      id,
      width: 720,
      height: 1280,
      durationSec: 12,
      orientation: 'portrait',
      aspectRatio: 0.5625,
      size: 4242,
    })),
  );
});

afterEach(async () => {
  if (created.length > 0) {
    await db.delete(posts).where(inArray(posts.id, [...created]));
    created.length = 0;
  }
  await db.delete(posts).where(eq(posts.oxyUserId, AUTHOR));
});

afterAll(async () => {
  await closePostgres();
});

describe('backfillMediaMetadata', () => {
  it('selects a post whose Oxy-backed video has no dimensions, and repairs it', async () => {
    const id = await seedWithMedia([{ id: UUID_FILE_ID, type: 'video' }]);

    const result = await backfillMediaMetadata({ dryRun: false });

    expect(result.scanned).toBe(1);
    expect(result.updated).toBe(1);
    expect(await mediaOf(id)).toEqual([
      {
        mediaId: UUID_FILE_ID,
        width: 720,
        height: 1280,
        durationSec: 12,
        orientation: 'portrait',
      },
    ]);
  });

  it('selects a legacy 24-hex id on the same arm', async () => {
    await seedWithMedia([{ id: HEX_FILE_ID, type: 'image' }]);

    const result = await backfillMediaMetadata({ dryRun: false });

    expect(result.scanned).toBe(1);
    expect(result.updated).toBe(1);
  });

  /**
   * The other arm of the discriminator. Oxy cannot answer for a remote URL, so
   * the row is a candidate only while a VIDEO still lacks orientation/duration —
   * which the AP ingest supplies when the remote server declared them.
   */
  it('selects a remote-URL video missing orientation, and leaves a complete one alone', async () => {
    await seedWithMedia([{ id: REMOTE_URL, type: 'video' }]);
    await seedWithMedia([
      { id: `${REMOTE_URL}?done`, type: 'video', orientation: 'portrait', durationSec: 9 },
    ]);

    const result = await backfillMediaMetadata({ dryRun: true });

    // One candidate hydrated, not two: the complete row never reaches the JS
    // predicate, which is the whole point of the SQL arm.
    expect(result.scanned).toBe(1);
  });

  it('does not select an Oxy-backed image that already has its dimensions', async () => {
    await seedWithMedia([{ id: HEX_FILE_ID, type: 'image', width: 800, height: 600 }]);

    const result = await backfillMediaMetadata({ dryRun: true });

    expect(result.scanned).toBe(0);
    expect(result.updated).toBe(0);
    expect(getServiceAssetMetadataByIds).not.toHaveBeenCalled();
  });

  it('writes nothing on a dry run', async () => {
    const id = await seedWithMedia([{ id: UUID_FILE_ID, type: 'video' }]);

    const result = await backfillMediaMetadata({ dryRun: true });

    expect(result.updated).toBe(1);
    expect(await mediaOf(id)).toEqual([
      {
        mediaId: UUID_FILE_ID,
        width: null,
        height: null,
        durationSec: null,
        orientation: null,
      },
    ]);
  });
});
