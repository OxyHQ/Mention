import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { gifs } from '../schema/discovery';
import { federatedMediaCache } from '../schema/federation';
import { gifCacheFileRetirements } from '../schema/oxyFiles';

/**
 * The GIF library's move out of the federation media cache (ADR 0043): which
 * old cache file each GIF file replaced, and what is still owed for it. Used by
 * `scripts/migrateGifLibraryToApplicationFiles.ts` and by the post insert.
 */

/**
 * Old cache file id → its application-owned replacement, for those of `fileIds`
 * that were retired. The post insert maps them before writing: a client that
 * fetched a GIF's file id before the move (a composer left open, a draft) must
 * not write a reference to a file the move is about to delete.
 */
export async function findRetiredGifFileRedirects(
  db: DatabaseOrTransaction,
  fileIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(fileIds.filter((id) => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ oldId: gifCacheFileRetirements.oldFileId, newId: gifCacheFileRetirements.newFileId })
    .from(gifCacheFileRetirements)
    .where(inArray(gifCacheFileRetirements.oldFileId, ids));
  return new Map(rows.map((row) => [row.oldId, row.newId]));
}

/** One GIF still in the cache namespace. */
export interface CacheGif {
  id: string;
  mp4FileId: string;
  previewFileId: string;
}

/** The next page of GIFs still stored in the federation cache, by id. */
export async function findCacheGifs(
  afterId: string | null,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<CacheGif[]> {
  return db
    .select({ id: gifs.id, mp4FileId: gifs.mp4FileId, previewFileId: gifs.previewFileId })
    .from(gifs)
    .where(
      and(
        eq(gifs.storage, 'federation_cache'),
        ...(afterId === null ? [] : [gt(gifs.id, afterId)]),
      ),
    )
    .orderBy(asc(gifs.id))
    .limit(limit);
}

/** Rows rewritten when a file id is replaced in posts. */
export interface FileIdRewrite {
  postMedia: number;
  variantMedia: number;
  altTexts: number;
  attachments: number;
  postIds: string[];
}

/**
 * Point every post row naming `oldId` at `newId`: shared media, variant media,
 * the variant alt texts keyed by it, and the media attachment pointers. The
 * triggers move the Oxy reference (`post` entity) from the old file to the new
 * one in the same transaction.
 */
export async function rewritePostFileId(
  tx: DatabaseOrTransaction,
  oldId: string,
  newId: string,
): Promise<FileIdRewrite> {
  const shared = [
    ...(await tx.execute<{ post_id: string }>(sql`
      update post_media set media_id = ${newId} where media_id = ${oldId} returning post_id
    `)),
  ];
  const variant = [
    ...(await tx.execute<{ post_id: string }>(sql`
      update post_variant_media vm set media_id = ${newId}
      from post_content_variants v
      where v.id = vm.variant_id and vm.media_id = ${oldId}
      returning v.post_id
    `)),
  ];
  const alt = [
    ...(await tx.execute<{ post_id: string }>(sql`
      update post_variant_alt_texts a set media_id = ${newId}
      from post_content_variants v
      where v.id = a.variant_id and a.media_id = ${oldId}
      returning v.post_id
    `)),
  ];
  const attachments = [
    ...(await tx.execute<{ post_id: string }>(sql`
      update post_attachments set attachment_id = ${newId}
      where type = 'media' and attachment_id = ${oldId}
      returning post_id
    `)),
  ];
  return {
    postMedia: shared.length,
    variantMedia: variant.length,
    altTexts: alt.length,
    attachments: attachments.length,
    postIds: [
      ...new Set([...shared, ...variant, ...alt, ...attachments].map((row) => row.post_id)),
    ],
  };
}

/**
 * Move one GIF to its application-owned files, in ONE transaction: record the
 * old ids as owed a delete, point the row and every post at the new ids. A row
 * that changed since it was read (moved by a concurrent run) is left alone.
 * Returns null when nothing was moved.
 */
export async function moveGifToApplicationFiles(
  gif: CacheGif,
  newMp4FileId: string,
  newPreviewFileId: string,
): Promise<FileIdRewrite | null> {
  return getDb().transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: gifs.id })
      .from(gifs)
      .where(
        and(
          eq(gifs.id, gif.id),
          eq(gifs.storage, 'federation_cache'),
          eq(gifs.mp4FileId, gif.mp4FileId),
          eq(gifs.previewFileId, gif.previewFileId),
        ),
      )
      .for('update')
      .limit(1);
    if (!locked) return null;

    const replacements = new Map<string, string>([[gif.mp4FileId, newMp4FileId]]);
    if (gif.previewFileId !== gif.mp4FileId) replacements.set(gif.previewFileId, newPreviewFileId);

    const retirements = [...replacements]
      .filter(([oldId, newId]) => oldId !== newId)
      .map(([oldFileId, newFileId]) => ({ oldFileId, newFileId, gifId: gif.id }));
    if (retirements.length > 0) {
      await tx.insert(gifCacheFileRetirements).values(retirements).onConflictDoNothing();
    }

    await tx
      .update(gifs)
      .set({
        mp4FileId: newMp4FileId,
        previewFileId: newPreviewFileId,
        storage: 'application',
        updatedAt: new Date(),
      })
      .where(eq(gifs.id, gif.id));

    const total: FileIdRewrite = {
      postMedia: 0,
      variantMedia: 0,
      altTexts: 0,
      attachments: 0,
      postIds: [],
    };
    for (const { oldFileId, newFileId } of retirements) {
      const rewrite = await rewritePostFileId(tx, oldFileId, newFileId);
      total.postMedia += rewrite.postMedia;
      total.variantMedia += rewrite.variantMedia;
      total.altTexts += rewrite.altTexts;
      total.attachments += rewrite.attachments;
      total.postIds.push(...rewrite.postIds);
    }
    total.postIds = [...new Set(total.postIds)];
    return total;
  });
}

/** Retirements still owed a delete. */
export async function findPendingRetirements(
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<Array<{ oldFileId: string; newFileId: string; attempts: number }>> {
  return db
    .select({
      oldFileId: gifCacheFileRetirements.oldFileId,
      newFileId: gifCacheFileRetirements.newFileId,
      attempts: gifCacheFileRetirements.attempts,
    })
    .from(gifCacheFileRetirements)
    .where(eq(gifCacheFileRetirements.state, 'pending'))
    .orderBy(asc(gifCacheFileRetirements.oldFileId))
    .limit(limit);
}

/**
 * Before deleting an old cache file: what still names it. Post rows left with
 * it (written by a request that raced the move) are rewritten here, in the
 * caller's transaction; a GIF row still on it (not moved yet) means wait; a
 * federated media-cache entry holding the same bytes means the file is the
 * cache's own now, and its eviction owns it.
 */
export async function prepareRetirement(
  tx: DatabaseOrTransaction,
  oldFileId: string,
  newFileId: string,
): Promise<{ verdict: 'delete' | 'wait' | 'kept'; rewrite: FileIdRewrite }> {
  const rewrite = await rewritePostFileId(tx, oldFileId, newFileId);
  const [gifUse] = await tx
    .select({ id: gifs.id })
    .from(gifs)
    .where(sql`${gifs.mp4FileId} = ${oldFileId} or ${gifs.previewFileId} = ${oldFileId}`)
    .limit(1);
  if (gifUse) return { verdict: 'wait', rewrite };
  const [cacheUse] = await tx
    .select({ id: federatedMediaCache.id })
    .from(federatedMediaCache)
    .where(
      sql`${federatedMediaCache.oxyFileId} = ${oldFileId} or ${federatedMediaCache.posterFileId} = ${oldFileId}`,
    )
    .limit(1);
  return { verdict: cacheUse ? 'kept' : 'delete', rewrite };
}

/** Record the outcome of one retirement. */
export async function settleRetirement(
  oldFileId: string,
  outcome: 'deleted' | 'not_found' | 'kept' | { error: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  if (typeof outcome === 'object') {
    await db
      .update(gifCacheFileRetirements)
      .set({
        attempts: sql`${gifCacheFileRetirements.attempts} + 1`,
        lastError: outcome.error.slice(0, 200),
        updatedAt: new Date(),
      })
      .where(eq(gifCacheFileRetirements.oldFileId, oldFileId));
    return;
  }
  await db
    .update(gifCacheFileRetirements)
    .set({ state: outcome, lastError: null, updatedAt: new Date() })
    .where(
      and(
        eq(gifCacheFileRetirements.oldFileId, oldFileId),
        eq(gifCacheFileRetirements.state, 'pending'),
      ),
    );
}
