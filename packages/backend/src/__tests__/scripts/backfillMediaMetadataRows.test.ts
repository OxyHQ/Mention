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
import { randomUUID } from 'node:crypto';
import { PostType, PostVisibility } from '@mention/shared-types';

const metadataByIds = vi.fn();
const { invalidatePostDetailCache } = vi.hoisted(() => ({ invalidatePostDetailCache: vi.fn() }));
vi.mock('../../services/postDetailCache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/postDetailCache')>()),
  invalidate: invalidatePostDetailCache,
}));
vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ assets: { metadataByIds } }),
}));

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import {
  postAuthorships,
  postContentVariants,
  postMedia,
  postVariantMedia,
} from '../../db/schema/postContent';
import { insertPostRecord } from '../../db/posts/postRepository';
import { backfillMediaMetadata } from '../../scripts/backfillMediaMetadata';
import { logger } from '../../utils/logger';
import { reconcileVideoMetadata } from '../../scripts/lib/reconcileVideoMetadata';

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
  invalidatePostDetailCache.mockReset();
  invalidatePostDetailCache.mockResolvedValue(undefined);
  metadataByIds.mockReset();
  metadataByIds.mockImplementation(async (ids: string[]) =>
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

  /**
   * The ladder arm. A video probed long ago still lacks its HLS stamp — nothing
   * copied it before 2026-10-10 — and without it every player is handed the
   * uploaded original, which an iPhone cannot decode when it is VP9.
   */
  it('selects a probed Oxy video whose HLS ladder was never stamped, and stamps it', async () => {
    metadataByIds.mockImplementation(async (ids: string[]) =>
      ids.map((id) => ({
        id,
        width: 720,
        height: 1280,
        durationSec: 12,
        orientation: 'portrait',
        hlsReadyAt: '2026-10-10T18:00:00.000Z',
      })),
    );
    const id = await seedWithMedia([
      {
        id: UUID_FILE_ID,
        type: 'video',
        width: 720,
        height: 1280,
        durationSec: 12,
        orientation: 'portrait',
      },
    ]);

    const result = await backfillMediaMetadata({ dryRun: false });

    expect(result.scanned).toBe(1);
    expect(result.updated).toBe(1);
    const [row] = await db
      .select({ hlsReadyAt: postMedia.hlsReadyAt })
      .from(postMedia)
      .where(eq(postMedia.postId, id));
    expect(row.hlsReadyAt?.toISOString()).toBe('2026-10-10T18:00:00.000Z');
  });

  it('does not select an Oxy-backed image that already has its dimensions', async () => {
    await seedWithMedia([{ id: HEX_FILE_ID, type: 'image', width: 800, height: 600 }]);

    const result = await backfillMediaMetadata({ dryRun: true });

    expect(result.scanned).toBe(0);
    expect(result.updated).toBe(0);
    expect(metadataByIds).not.toHaveBeenCalled();
  });

  /**
   * The counters have to survive a killed process. The sweep is bounded by its
   * container's `timeout` and holds no cursor, so a run that outlives the bound
   * is SIGTERMed before the summary line — and on a DRY run the summary is the
   * only thing anyone wanted. A per-page progress line is what makes a partial
   * preview still answer "how big is the backlog".
   */
  it('logs progress per page, so a killed run still reports a number', async () => {
    await seedWithMedia([{ id: UUID_FILE_ID, type: 'video' }]);
    const progress = vi.spyOn(logger, 'info');

    await backfillMediaMetadata({ dryRun: true });

    const lines = progress.mock.calls.filter(([message]) =>
      String(message).includes('[backfillMediaMetadata] progress'),
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0][1]).toMatchObject({ dryRun: true, scanned: 1, updated: 1 });
    progress.mockRestore();
  });

  /**
   * ONE Oxy round trip for the whole page, not one per post.
   *
   * The sweep called `enrichFromOxy` inside the row loop, so a page of 200
   * posts was 200 requests to `/assets/service/by-ids` carrying one to four ids
   * each. Oxy rate-limits its service endpoints and answered the first
   * production run with a wall of 429s — each of which left that post
   * un-enriched while the counters recorded it as "nothing to do".
   */
  it('asks Oxy once for the whole page, not once per post', async () => {
    await seedWithMedia([{ id: UUID_FILE_ID, type: 'video' }]);
    await seedWithMedia([{ id: HEX_FILE_ID, type: 'image' }]);
    await seedWithMedia([{ id: `${UUID_FILE_ID}-b`, type: 'video' }]);

    const result = await backfillMediaMetadata({ dryRun: true });

    expect(result.scanned).toBe(3);
    expect(metadataByIds).toHaveBeenCalledTimes(1);
    expect(metadataByIds.mock.calls[0][0]).toHaveLength(3);
  });

  /**
   * A throttled page is not a clean page. `enrichFromOxy` swallows the failure
   * and returns the items unchanged, which is indistinguishable from "Oxy has
   * nothing to add" — so the sweep used to count those posts as `skipped` and
   * report a clean run over a set it had failed to resolve.
   */
  it('reports posts it could not resolve instead of counting them clean', async () => {
    await seedWithMedia([{ id: UUID_FILE_ID, type: 'video' }]);
    metadataByIds.mockRejectedValue(
      new Error('Could not resolve asset metadata for 1 id(s) — status 429'),
    );

    const result = await backfillMediaMetadata({ dryRun: true });

    expect(result.unresolved).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(0);
    // Retried before giving up: a 429 is "ask again later", not a verdict.
    expect(metadataByIds.mock.calls.length).toBeGreaterThan(1);
  }, 30_000);

  /**
   * The repair updates media rows IN PLACE. It used to call
   * `replacePostContent`, which deletes and re-inserts the post's whole content
   * graph — right for an edit, wrong for enrichment: it rewrites variants,
   * attachments, sources and mentions whose contents are not changing, and it
   * cost ~120 ms per post (230/sec reading, 8-25/sec writing) on a 63,705-post
   * backlog.
   *
   * The row IDENTITY is what proves it: a delete-then-insert mints new ids, so
   * an unchanged `post_media.id` and an unchanged variant id say the rows
   * survived rather than being recreated.
   */
  it('updates the media rows in place, keeping their identity and their siblings', async () => {
    const postId = await seedWithMedia([
      { id: UUID_FILE_ID, type: 'video', alt: 'a caption worth keeping' },
    ]);

    const before = await db
      .select({ id: postMedia.id, mediaId: postMedia.mediaId, alt: postMedia.alt })
      .from(postMedia)
      .where(eq(postMedia.postId, postId));
    const variantsBefore = await db
      .select({ id: postContentVariants.id })
      .from(postContentVariants)
      .where(eq(postContentVariants.postId, postId));

    await backfillMediaMetadata({ dryRun: false });

    const after = await db
      .select({
        id: postMedia.id,
        mediaId: postMedia.mediaId,
        alt: postMedia.alt,
        width: postMedia.width,
      })
      .from(postMedia)
      .where(eq(postMedia.postId, postId));
    const variantsAfter = await db
      .select({ id: postContentVariants.id })
      .from(postContentVariants)
      .where(eq(postContentVariants.postId, postId));

    expect(after[0].width).toBe(720);
    // Same row, not a replacement — and the fields enrichment does not own are
    // exactly as they were.
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].mediaId).toBe(before[0].mediaId);
    expect(after[0].alt).toBe('a caption worth keeping');
    // And the rest of the content graph was never in the write's path.
    expect(variantsAfter.map((v) => v.id)).toEqual(variantsBefore.map((v) => v.id));
  });

  /**
   * The write addresses rows by `(post_id, position)`, so a post with several
   * media must have each row take ITS OWN values — an off-by-one here would be
   * invisible in the counters and would put a portrait video's dimensions on a
   * landscape one.
   */
  it('gives each position its own values', async () => {
    const postId = await seedWithMedia([
      { id: UUID_FILE_ID, type: 'video' },
      { id: HEX_FILE_ID, type: 'image' },
    ]);
    metadataByIds.mockImplementation(async (ids: string[]) =>
      ids.map((id) => ({
        id,
        width: id === UUID_FILE_ID ? 720 : 1600,
        height: id === UUID_FILE_ID ? 1280 : 900,
        durationSec: id === UUID_FILE_ID ? 12 : undefined,
        orientation: id === UUID_FILE_ID ? 'portrait' : 'landscape',
      })),
    );

    await backfillMediaMetadata({ dryRun: false });

    const rows = await db
      .select({
        position: postMedia.position,
        mediaId: postMedia.mediaId,
        width: postMedia.width,
        orientation: postMedia.orientation,
      })
      .from(postMedia)
      .where(eq(postMedia.postId, postId))
      .orderBy(postMedia.position);

    expect(rows).toEqual([
      { position: 0, mediaId: UUID_FILE_ID, width: 720, orientation: 'portrait' },
      { position: 1, mediaId: HEX_FILE_ID, width: 1600, orientation: 'landscape' },
    ]);
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

describe('backfillMediaMetadata — targeted video refresh', () => {
  const staleVideo = {
    id: UUID_FILE_ID,
    type: 'video' as const,
    width: 1920,
    height: 1080,
    orientation: 'landscape' as const,
    aspectRatio: 1920 / 1080,
    durationSec: 12,
    sizeBytes: 4242,
    hlsReadyAt: '2026-10-01T00:00:00.000Z',
    alt: 'Keep this caption',
  };
  const readyAt = '2026-10-23T08:00:00.000Z';
  const metadata = {
    id: UUID_FILE_ID,
    width: 720,
    height: 1280,
    durationSec: 12,
    orientation: 'portrait',
    aspectRatio: 0.5625,
    size: 4242,
    hlsReadyAt: readyAt,
  };

  beforeEach(() => {
    metadataByIds.mockResolvedValue([metadata]);
  });

  it('refreshes complete metadata only for the target file and remains idempotent', async () => {
    const postId = await seedWithMedia([staleVideo, { ...staleVideo, id: HEX_FILE_ID }]);
    const unrelatedId = await seedWithMedia([{ ...staleVideo, id: `${HEX_FILE_ID}-other` }]);
    const before = await db
      .select()
      .from(postMedia)
      .where(eq(postMedia.postId, postId))
      .orderBy(postMedia.position);
    const unrelated = await mediaOf(unrelatedId);
    const variantsBefore = await db
      .select()
      .from(postContentVariants)
      .where(eq(postContentVariants.postId, postId));
    const authorsBefore = await db
      .select()
      .from(postAuthorships)
      .where(eq(postAuthorships.postId, postId));

    const result = await backfillMediaMetadata({ fileId: UUID_FILE_ID });

    expect(result).toEqual({ scanned: 1, updated: 1, skipped: 0, unresolved: 0 });
    expect(metadataByIds).toHaveBeenCalledWith([UUID_FILE_ID]);
    const after = await db
      .select()
      .from(postMedia)
      .where(eq(postMedia.postId, postId))
      .orderBy(postMedia.position);
    expect(after[0]).toEqual({
      ...before[0],
      width: 720,
      height: 1280,
      orientation: 'portrait',
      aspectRatio: 0.5625,
      hlsReadyAt: new Date(readyAt),
    });
    expect(after[1]).toEqual(before[1]);
    expect(await mediaOf(unrelatedId)).toEqual(unrelated);
    expect(
      await db.select().from(postContentVariants).where(eq(postContentVariants.postId, postId)),
    ).toEqual(variantsBefore);
    expect(
      await db.select().from(postAuthorships).where(eq(postAuthorships.postId, postId)),
    ).toEqual(authorsBefore);
    expect(await backfillMediaMetadata({ fileId: UUID_FILE_ID })).toEqual({
      scanned: 1,
      updated: 0,
      skipped: 1,
      unresolved: 0,
    });
  });

  it('refreshes language overrides, including posts with no shared target, in bounded pages', async () => {
    const sharedPostId = await seedWithMedia([staleVideo]);
    const sharedVariants = await db
      .select()
      .from(postContentVariants)
      .where(eq(postContentVariants.postId, sharedPostId));
    await db.insert(postVariantMedia).values({
      variantId: sharedVariants[0].id,
      position: 0,
      mediaId: UUID_FILE_ID,
      type: 'video',
      width: 1920,
      height: 1080,
      alt: 'English override',
    });
    const variantOnly = await insertPostRecord({
      oxyUserId: AUTHOR,
      authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
      type: PostType.TEXT,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      content: {
        variants: [
          { source: 'author', tag: 'es', text: 'Texto original', media: [staleVideo] },
          {
            source: 'author',
            tag: 'fr',
            text: 'Texte original',
            media: [{ ...staleVideo, id: HEX_FILE_ID }],
          },
        ],
      },
    });
    created.push(variantOnly.id);
    const before = await db.select().from(postVariantMedia).orderBy(postVariantMedia.id);

    const result = await backfillMediaMetadata({ fileId: UUID_FILE_ID, batchSize: 1 });

    expect(result).toEqual({ scanned: 2, updated: 2, skipped: 0, unresolved: 0 });
    const after = await db.select().from(postVariantMedia).orderBy(postVariantMedia.id);
    for (let index = 0; index < before.length; index++) {
      const previous = before[index];
      if (previous.mediaId !== UUID_FILE_ID) {
        expect(after[index]).toEqual(previous);
      } else {
        expect(after[index]).toEqual({
          ...previous,
          width: 720,
          height: 1280,
          durationSec: 12,
          sizeBytes: 4242,
          orientation: 'portrait',
          aspectRatio: 0.5625,
          hlsReadyAt: new Date(readyAt),
        });
      }
    }
    expect(await backfillMediaMetadata({ fileId: UUID_FILE_ID, batchSize: 1 })).toEqual({
      scanned: 2,
      updated: 0,
      skipped: 2,
      unresolved: 0,
    });
  });

  it('reports a dry-run change without replacing existing values', async () => {
    const postId = await seedWithMedia([staleVideo]);
    const before = await db.select().from(postMedia).where(eq(postMedia.postId, postId));
    expect(await backfillMediaMetadata({ fileId: UUID_FILE_ID, dryRun: true })).toEqual({
      scanned: 1,
      updated: 1,
      skipped: 0,
      unresolved: 0,
    });
    expect(await db.select().from(postMedia).where(eq(postMedia.postId, postId))).toEqual(before);
  });

  it('reports an omitted Oxy file as unresolved rather than already repaired', async () => {
    const postId = await seedWithMedia([staleVideo]);
    metadataByIds.mockResolvedValue([]);
    expect(await backfillMediaMetadata({ fileId: UUID_FILE_ID })).toEqual({
      scanned: 1,
      updated: 0,
      skipped: 0,
      unresolved: 1,
    });
    expect((await mediaOf(postId))[0].width).toBe(1920);
  });

  it('does not combine incomplete Oxy metadata with the old ready stamp and report success', async () => {
    const postId = await seedWithMedia([staleVideo]);
    metadataByIds.mockResolvedValue([{ id: UUID_FILE_ID, width: 720, height: 1280 }]);
    expect(await backfillMediaMetadata({ fileId: UUID_FILE_ID })).toEqual({
      scanned: 1,
      updated: 0,
      skipped: 0,
      unresolved: 1,
    });
    expect((await mediaOf(postId))[0].width).toBe(1920);
  });

  it('reports a failed Oxy lookup as unresolved and preserves the stored dimensions', async () => {
    const postId = await seedWithMedia([staleVideo]);
    metadataByIds.mockRejectedValue(new Error('Oxy metadata temporarily unavailable'));
    expect(await backfillMediaMetadata({ fileId: UUID_FILE_ID })).toEqual({
      scanned: 1,
      updated: 0,
      skipped: 0,
      unresolved: 1,
    });
    expect((await mediaOf(postId))[0].width).toBe(1920);
  }, 30_000);

  it.each(['row', 'file'])(
    'does not overwrite a %s replaced while the lookup was running',
    async (change) => {
      const postId = await seedWithMedia([staleVideo]);
      metadataByIds.mockImplementationOnce(async () => {
        await db
          .update(postMedia)
          .set(change === 'row' ? { id: randomUUID() } : { mediaId: HEX_FILE_ID })
          .where(eq(postMedia.postId, postId));
        return [metadata];
      });
      expect(await backfillMediaMetadata({ fileId: UUID_FILE_ID })).toEqual({
        scanned: 1,
        updated: 0,
        skipped: 1,
        unresolved: 0,
      });
      expect((await mediaOf(postId))[0].width).toBe(1920);
    },
  );

  it('does not treat a missing or remote file selector as a full backfill', async () => {
    await seedWithMedia([staleVideo]);
    for (const fileId of ['', REMOTE_URL, ` ${UUID_FILE_ID}`]) {
      await expect(backfillMediaMetadata({ fileId })).rejects.toThrow('--file-id');
    }
    expect(metadataByIds).not.toHaveBeenCalled();
  });
});

describe('bounded video metadata reconciliation', () => {
  const readyAt = '2026-10-23T18:00:00.000Z';
  const oldReadyAt = '2026-10-01T00:00:00.000Z';
  const stale = (id: string) => ({
    id,
    type: 'video',
    width: 1920,
    height: 1080,
    orientation: 'landscape',
    aspectRatio: 1920 / 1080,
    durationSec: 12,
    sizeBytes: 4242,
    hlsReadyAt: oldReadyAt,
    alt: 'Preserve the caption',
  });
  const current = (id: string) => ({
    id,
    width: 720,
    height: 1280,
    orientation: 'portrait',
    aspectRatio: 0.5625,
    durationSec: 12,
    size: 4242,
    hlsReadyAt: readyAt,
  });
  const read = () => db.select().from(postMedia).orderBy(postMedia.id);

  beforeEach(() => {
    metadataByIds.mockImplementation(async (ids: string[]) => ids.map(current));
  });

  it('deduplicates both tables, preserves content identity, and invalidates only committed changed posts', async () => {
    const sharedId = await seedWithMedia([stale(UUID_FILE_ID), { id: HEX_FILE_ID, type: 'image' }]);
    const variantOnly = await seedWithMedia([]);
    const variants = await db
      .select()
      .from(postContentVariants)
      .where(inArray(postContentVariants.postId, [sharedId, variantOnly]));
    for (const variant of variants) {
      await db.insert(postVariantMedia).values({
        variantId: variant.id,
        position: 0,
        mediaId: variant.postId === variantOnly ? HEX_FILE_ID : UUID_FILE_ID,
        type: 'video',
        width: 1920,
        height: 1080,
        alt: 'Local override',
        hlsReadyAt: new Date(oldReadyAt),
      });
    }
    const remoteId = await seedWithMedia([stale(REMOTE_URL)]);
    const before = await read();
    const variantBefore = await db.select().from(postVariantMedia).orderBy(postVariantMedia.id);
    invalidatePostDetailCache.mockClear();
    invalidatePostDetailCache.mockImplementation(async (postId: string) => {
      // A separate connection observes committed values when invalidation starts.
      expect([sharedId, variantOnly]).toContain(postId);
      expect(
        (await db.select().from(postVariantMedia)).every(
          (row) => row.hlsReadyAt?.toISOString() === readyAt,
        ),
      ).toBe(true);
      expect(
        (await db.select().from(postMedia).where(eq(postMedia.mediaId, UUID_FILE_ID)))[0].width,
      ).toBe(720);
    });

    const {
      passes: [result],
    } = await reconcileVideoMetadata();

    expect(result).toMatchObject({
      scanned: 2,
      updated: 2,
      unresolved: 0,
      rowsUpdated: 3,
      postsUpdated: 2,
      reachedEnd: true,
    });
    expect(metadataByIds).toHaveBeenCalledExactlyOnceWith([UUID_FILE_ID, HEX_FILE_ID]);
    expect(new Set(invalidatePostDetailCache.mock.calls.map(([id]) => id))).toEqual(
      new Set([sharedId, variantOnly]),
    );
    const after = await read();
    for (let i = 0; i < before.length; i++) {
      const row = before[i];
      expect(after[i]).toEqual(
        row.mediaId === UUID_FILE_ID
          ? {
              ...row,
              width: 720,
              height: 1280,
              orientation: 'portrait',
              aspectRatio: 0.5625,
              hlsReadyAt: new Date(readyAt),
            }
          : row,
      );
    }
    expect(after.find((row) => row.postId === remoteId)).toEqual(
      before.find((row) => row.postId === remoteId),
    );
    const variantAfter = await db.select().from(postVariantMedia).orderBy(postVariantMedia.id);
    expect(variantAfter).toEqual(
      variantBefore.map((row) => ({
        ...row,
        width: 720,
        height: 1280,
        orientation: 'portrait',
        aspectRatio: 0.5625,
        durationSec: 12,
        sizeBytes: 4242,
        hlsReadyAt: new Date(readyAt),
      })),
    );
    invalidatePostDetailCache.mockClear();
    expect((await reconcileVideoMetadata()).passes[0]).toMatchObject({
      scanned: 2,
      updated: 0,
      unchanged: 2,
      rowsUpdated: 0,
    });
    expect(invalidatePostDetailCache).not.toHaveBeenCalled();
  });

  it('bounds Oxy lookups to 100 deduplicated files and resumes from the exact keyset boundary', async () => {
    const ids = Array.from({ length: 103 }, () => randomUUID()).sort();
    await seedWithMedia(ids.map(stale));
    await seedWithMedia([stale(ids[0])]);
    invalidatePostDetailCache.mockClear();
    const first = (await reconcileVideoMetadata({ limitFiles: 101, dryRun: true })).passes[0];
    expect(first).toMatchObject({
      scanned: 101,
      updated: 101,
      reachedEnd: false,
      resumeAfterFileId: ids[100],
    });
    expect(metadataByIds.mock.calls.map(([batch]) => batch.length)).toEqual([100, 1]);
    expect(metadataByIds.mock.calls.flatMap(([batch]) => batch)).toEqual(ids.slice(0, 101));
    metadataByIds.mockClear();
    const last = (
      await reconcileVideoMetadata({
        afterFileId: first.resumeAfterFileId ?? undefined,
        limitFiles: 101,
        dryRun: true,
      })
    ).passes[0];
    expect(last).toMatchObject({ scanned: 2, reachedEnd: true, resumeAfterFileId: null });
    expect(metadataByIds).toHaveBeenCalledExactlyOnceWith(ids.slice(101));
    expect((await read()).every((row) => row.width === 1920)).toBe(true);
    expect(invalidatePostDetailCache).not.toHaveBeenCalled();
  });

  it('keeps a resumable checkpoint before unresolved files and never treats a failed source as current', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
    await seedWithMedia(ids.map(stale));
    metadataByIds.mockResolvedValue([current(ids[0]), current(ids[2])]);
    const partial = (await reconcileVideoMetadata()).passes[0];
    expect(partial).toMatchObject({
      scanned: 3,
      updated: 2,
      unresolved: 1,
      reachedEnd: true,
      scannedThroughFileId: ids[2],
      resumeAfterFileId: ids[0],
    });
    metadataByIds.mockRejectedValue(new Error('upstream unavailable'));
    invalidatePostDetailCache.mockClear();
    const before = await read();
    expect((await reconcileVideoMetadata({ afterFileId: ids[0] })).passes[0]).toMatchObject({
      scanned: 2,
      updated: 0,
      unchanged: 0,
      unresolved: 2,
      resumeAfterFileId: ids[0],
    });
    expect(await read()).toEqual(before);
    expect(invalidatePostDetailCache).not.toHaveBeenCalled();
    metadataByIds.mockImplementation(async (batch: string[]) => batch.map(current));
    expect((await reconcileVideoMetadata({ afterFileId: ids[0] })).passes[0]).toMatchObject({
      scanned: 2,
      updated: 1,
      unchanged: 1,
      unresolved: 0,
    });
  });

  it('does not overwrite a row edited to another file while Oxy responds', async () => {
    const id = await seedWithMedia([stale(UUID_FILE_ID)]);
    const [original] = await read();
    invalidatePostDetailCache.mockClear();
    metadataByIds.mockImplementation(async () => {
      await db
        .update(postMedia)
        .set({ mediaId: HEX_FILE_ID, width: 400, alt: 'Concurrent edit' })
        .where(eq(postMedia.id, original.id));
      return [current(UUID_FILE_ID)];
    });
    expect((await reconcileVideoMetadata()).passes[0]).toMatchObject({
      updated: 0,
      rowsUpdated: 0,
    });
    expect((await read())[0]).toMatchObject({
      id: original.id,
      postId: id,
      mediaId: HEX_FILE_ID,
      width: 400,
      alt: 'Concurrent edit',
    });
    expect(invalidatePostDetailCache).not.toHaveBeenCalled();
  });

  it('never rolls a newer readiness stamp back, including an update during lookup', async () => {
    await seedWithMedia([stale(UUID_FILE_ID)]);
    const [row] = await read();
    const later = new Date('2026-10-24T00:00:00.000Z');
    metadataByIds.mockImplementation(async () => {
      await db
        .update(postMedia)
        .set({ hlsReadyAt: later, width: 1080 })
        .where(eq(postMedia.id, row.id));
      return [current(UUID_FILE_ID)];
    });
    expect((await reconcileVideoMetadata()).passes[0].rowsUpdated).toBe(0);
    expect((await read())[0]).toMatchObject({ width: 1080, hlsReadyAt: later });
    metadataByIds.mockResolvedValue([current(UUID_FILE_ID)]);
    expect((await reconcileVideoMetadata()).passes[0]).toMatchObject({
      updated: 0,
      unresolved: 1,
      resumeAfterFileId: null,
    });
  });

  it('runs later complete passes even when the first is unchanged while Oxy is still encoding', async () => {
    await seedWithMedia([{ ...stale(UUID_FILE_ID), ...current(UUID_FILE_ID) }]);
    const later = '2026-10-24T00:00:00.000Z';
    metadataByIds
      .mockResolvedValueOnce([current(UUID_FILE_ID)])
      .mockResolvedValueOnce([{ ...current(UUID_FILE_ID), hlsReadyAt: later }]);
    const result = await reconcileVideoMetadata({ passes: 2, passDelaySeconds: 0 });
    expect(result.passes.map((pass) => [pass.updated, pass.unchanged, pass.reachedEnd])).toEqual([
      [0, 1, true],
      [1, 0, true],
    ]);
    expect((await read())[0].hlsReadyAt?.toISOString()).toBe(later);
  });

  it('stops at a bounded partial pass rather than repeatedly scanning its prefix', async () => {
    await seedWithMedia([stale(UUID_FILE_ID), stale(HEX_FILE_ID)]);
    const result = await reconcileVideoMetadata({ passes: 3, limitFiles: 1, passDelaySeconds: 0 });
    expect(result.passes).toHaveLength(1);
    expect(result.passes[0]).toMatchObject({
      scanned: 1,
      reachedEnd: false,
      resumeAfterFileId: UUID_FILE_ID,
    });
  });

  it.each([
    { limitFiles: 0 },
    { limitFiles: 1.5 },
    { limitFiles: 1000001 },
    { passes: 0 },
    { passes: 11 },
    { passDelaySeconds: -1 },
    { afterFileId: REMOTE_URL },
    { afterFileId: ` ${UUID_FILE_ID}` },
  ])('rejects invalid bounds or cursor before reading Oxy: %j', async (options) => {
    await expect(reconcileVideoMetadata(options)).rejects.toThrow();
    expect(metadataByIds).not.toHaveBeenCalled();
  });
});
