/**
 * The GIF library's move out of the federation media cache, against REAL rows:
 * each cache-stored GIF gets application-owned files, every post naming an old
 * file is rewritten in the same transaction, and the old cache files are deleted
 * once nothing names them. Oxy is injected.
 *
 * Moves every cache-stored GIF in the database, so this file runs against its
 * own (`isolatedDatabaseFiles.ts`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { deletePostRecord, insertPostRecord } from '../../db/posts/postRepository';
import { gifs } from '../../db/schema/discovery';
import { federatedMediaCache } from '../../db/schema/federation';
import { gifCacheFileRetirements, oxyFileReferenceSync } from '../../db/schema/oxyFiles';
import { postMedia } from '../../db/schema/postContent';
import {
  migrateGifLibraryToApplicationFiles,
  type GifLibraryMigrationDeps,
} from '../../scripts/migrateGifLibraryToApplicationFiles';

const AUTHOR = 'oxy-gif-migration-author';
const fid = (label: string) => `ogm-${label}-${randomUUID().slice(0, 8)}`;

const deps = {
  importFile: vi.fn(async (url: string) => `app-${url.split('/').pop()}`),
  publicUrl: (id: string) => `https://cloud.oxy.so/${id}`,
  deleteCacheFile: vi.fn(async (_id: string) => 'deleted' as const),
  invalidatePost: vi.fn(async (_id: string) => undefined),
  pause: async () => undefined,
} satisfies GifLibraryMigrationDeps;

async function cacheGif(mp4: string, preview = mp4) {
  const [row] = await getDb()
    .insert(gifs)
    .values({
      klipyId: fid('klipy'),
      width: 10,
      height: 10,
      mp4FileId: mp4,
      previewFileId: preview,
    })
    .returning();
  return row;
}

async function gifPost(fileId: string) {
  const record = await insertPostRecord({
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.IMAGE,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: {
      variants: [{ source: 'author', text: 'gif', tag: 'en', alt: { [fileId]: 'a cat' } }],
      media: [{ id: fileId, type: 'gif' }],
    },
  });
  return record.id;
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  deps.importFile.mockClear();
  deps.deleteCacheFile.mockClear();
  deps.invalidatePost.mockClear();
});

afterAll(async () => {
  await closePostgres();
});

describe('migrateGifLibraryToApplicationFiles', () => {
  it('a dry run counts and changes nothing', async () => {
    const mp4 = fid('dry');
    const gif = await cacheGif(mp4);
    const postId = await gifPost(mp4);

    const result = await migrateGifLibraryToApplicationFiles({ dryRun: true, deps });

    expect(result.gifsSeen).toBeGreaterThanOrEqual(1);
    expect(result.postMediaToRewrite).toBeGreaterThanOrEqual(1);
    expect(deps.importFile).not.toHaveBeenCalled();
    const [row] = await getDb().select().from(gifs).where(eq(gifs.id, gif.id));
    expect(row.storage).toBe('federation_cache');
    await deletePostRecord(postId);
    await getDb().delete(gifs).where(eq(gifs.id, gif.id));
  });

  it('moves a GIF, rewrites its posts and deletes the old cache files', async () => {
    const mp4 = fid('mp4');
    const preview = fid('preview');
    const gif = await cacheGif(mp4, preview);
    const postId = await gifPost(mp4);

    const result = await migrateGifLibraryToApplicationFiles({ dryRun: false, deps });

    expect(deps.importFile).toHaveBeenCalledWith(`https://cloud.oxy.so/${mp4}`);
    expect(deps.importFile).toHaveBeenCalledWith(`https://cloud.oxy.so/${preview}`);
    const [row] = await getDb().select().from(gifs).where(eq(gifs.id, gif.id));
    expect(row).toMatchObject({
      storage: 'application',
      mp4FileId: `app-${mp4}`,
      previewFileId: `app-${preview}`,
    });
    const media = await getDb()
      .select({ mediaId: postMedia.mediaId })
      .from(postMedia)
      .where(eq(postMedia.postId, postId));
    expect(media).toEqual([{ mediaId: `app-${mp4}` }]);
    const alt = await getDb().execute<{ media_id: string }>(sql`
      select a.media_id from post_variant_alt_texts a
      join post_content_variants v on v.id = a.variant_id where v.post_id = ${postId}
    `);
    expect([...alt].map((r) => r.media_id)).toEqual([`app-${mp4}`]);
    expect(deps.invalidatePost).toHaveBeenCalledWith(postId);

    // The references moved with the rows: the post and the GIF now use the new files.
    const marks = await getDb()
      .select({ fileId: oxyFileReferenceSync.fileId, entityType: oxyFileReferenceSync.entityType })
      .from(oxyFileReferenceSync)
      .where(inArray(oxyFileReferenceSync.fileId, [`app-${mp4}`, `app-${preview}`]));
    expect(marks.map((m) => `${m.entityType}:${m.fileId}`).sort()).toEqual(
      [`gif:app-${mp4}`, `gif:app-${preview}`, `post:app-${mp4}`].sort(),
    );

    expect(deps.deleteCacheFile).toHaveBeenCalledWith(mp4);
    expect(deps.deleteCacheFile).toHaveBeenCalledWith(preview);
    const retirements = await getDb()
      .select({ old: gifCacheFileRetirements.oldFileId, state: gifCacheFileRetirements.state })
      .from(gifCacheFileRetirements)
      .where(inArray(gifCacheFileRetirements.oldFileId, [mp4, preview]));
    expect(retirements.every((r) => r.state === 'deleted')).toBe(true);
    expect(result.gifsFailed).toBe(0);
    expect(result.retirementsFailed).toBe(0);

    // A re-run moves nothing again.
    deps.importFile.mockClear();
    await migrateGifLibraryToApplicationFiles({ dryRun: false, deps });
    expect(deps.importFile).not.toHaveBeenCalled();
    await deletePostRecord(postId);
  });

  it('keeps an old file the federated media cache also holds', async () => {
    const mp4 = fid('shared-bytes');
    await cacheGif(mp4);
    await getDb()
      .insert(federatedMediaCache)
      .values({
        remoteUrl: `https://remote.example/${mp4}.mp4`,
        oxyFileId: mp4,
        state: 'cached',
      });

    await migrateGifLibraryToApplicationFiles({ dryRun: false, deps });

    expect(deps.deleteCacheFile).not.toHaveBeenCalledWith(mp4);
    const [retirement] = await getDb()
      .select({ state: gifCacheFileRetirements.state })
      .from(gifCacheFileRetirements)
      .where(eq(gifCacheFileRetirements.oldFileId, mp4));
    expect(retirement.state).toBe('kept');
  });

  it('leaves a GIF whose import fails as it was, and fails the run', async () => {
    const mp4 = fid('fails');
    const gif = await cacheGif(mp4);
    deps.importFile.mockRejectedValueOnce(Object.assign(new Error('down'), { status: 503 }));

    const result = await migrateGifLibraryToApplicationFiles({ dryRun: false, deps });

    expect(result.gifsFailed).toBe(1);
    const [row] = await getDb().select().from(gifs).where(eq(gifs.id, gif.id));
    expect(row).toMatchObject({ storage: 'federation_cache', mp4FileId: mp4 });

    // The next run moves it.
    const again = await migrateGifLibraryToApplicationFiles({ dryRun: false, deps });
    expect(again.gifsMoved).toBe(1);
  });
});
