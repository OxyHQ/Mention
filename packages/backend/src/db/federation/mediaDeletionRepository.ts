import { and, asc, eq, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { postContentVariants, postMedia, postVariantMedia } from '../schema/postContent';
import { federatedMediaDeletions, federatedMediaPosters } from '../schema/federation';
import { userSettings } from '../schema/userProfile';

/**
 * The outbox for deleting Oxy files Mention re-hosted from a federated source
 * — see `federated_media_deletions` for the state machine.
 *
 * ## The race this is shaped around
 *
 * Oxy stores one file per content hash, so two imports of the same bytes get
 * the SAME file id. Deleting a file because the post that used it was deleted
 * is therefore only safe if nothing else uses it — and "nothing else" must hold
 * against an import that is, right now, about to insert a post with that id.
 *
 * Both sides take `pg_advisory_xact_lock('federated-media:<id>')`:
 *  - the drain, while it re-checks every reference and (if none) writes the
 *    TOMBSTONE (`deleting`);
 *  - the post insert ({@link assertFederatedMediaUsable}), while it checks for a
 *    tombstone before writing its media rows.
 * Whichever commits first wins: the insert lands first → the drain sees the
 * reference and keeps the file (`in_use`); the tombstone lands first → the
 * insert is refused and its import retries later with a fresh upload.
 */

/** A file this app no longer references is being, or has been, deleted in Oxy. */
const TOMBSTONE_STATES = ['deleting', 'deleted', 'not_found'] as const;

function lockKey(fileId: string) {
  return sql`pg_advisory_xact_lock(hashtext(${`federated-media:${fileId}`}))`;
}

/** Take the per-file locks in a fixed order, so two multi-file transactions cannot deadlock. */
async function lockFiles(tx: DatabaseOrTransaction, fileIds: readonly string[]): Promise<void> {
  for (const id of [...new Set(fileIds)].sort()) {
    await tx.execute(sql`select ${lockKey(id)}`);
  }
}

/** Thrown by the post insert when a federated media id it is about to store is tombstoned. */
export class FederatedMediaGoneError extends Error {
  readonly fileIds: string[];
  constructor(fileIds: string[]) {
    super('A federated media file this post references is being deleted');
    this.name = 'FederatedMediaGoneError';
    this.fileIds = fileIds;
  }
}

/**
 * Inside the post insert's transaction: lock each re-hosted federated file id
 * and refuse if any is tombstoned. The locks are held to commit, so the drain
 * cannot tombstone one of them between this check and the media rows landing.
 */
export async function assertFederatedMediaUsable(
  tx: DatabaseOrTransaction,
  fileIds: readonly string[],
): Promise<void> {
  if (fileIds.length === 0) return;
  await lockFiles(tx, fileIds);
  const gone = await tx
    .select({ oxyFileId: federatedMediaDeletions.oxyFileId })
    .from(federatedMediaDeletions)
    .where(and(
      inArray(federatedMediaDeletions.oxyFileId, [...fileIds]),
      inArray(federatedMediaDeletions.state, [...TOMBSTONE_STATES]),
    ));
  if (gone.length > 0) throw new FederatedMediaGoneError(gone.map((row) => row.oxyFileId));
}

/**
 * Queue deletion of the re-hosted federated media of `postIds` — called BEFORE
 * those posts are deleted, in the same transaction when there is one. Queuing
 * is always safe: nothing is deleted until the drain has re-checked every
 * reference under the lock, so a queued file that is still (or again) in use
 * is simply kept. An `in_use` row is re-armed; a tombstone stays as it is.
 */
export async function enqueueFederatedMediaDeletionsForPosts(
  postIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  if (postIds.length === 0) return 0;
  const ids = [...postIds];
  const rows = await db
    .select({ mediaId: postMedia.mediaId })
    .from(postMedia)
    .where(and(inArray(postMedia.postId, ids), eq(postMedia.cachedFromFederation, true)));
  const variantRows = await db
    .select({ mediaId: postVariantMedia.mediaId })
    .from(postVariantMedia)
    .innerJoin(postContentVariants, eq(postContentVariants.id, postVariantMedia.variantId))
    .where(and(inArray(postContentVariants.postId, ids), eq(postVariantMedia.cachedFromFederation, true)));
  const fileIds = [...new Set([...rows, ...variantRows].map((row) => row.mediaId))];
  return enqueueFederatedMediaDeletions(fileIds, db);
}

/** Queue deletion of specific re-hosted federated files (see above). */
export async function enqueueFederatedMediaDeletions(
  fileIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  if (fileIds.length === 0) return 0;
  const written = await db
    .insert(federatedMediaDeletions)
    .values(fileIds.map((oxyFileId) => ({ oxyFileId })))
    .onConflictDoUpdate({
      target: federatedMediaDeletions.oxyFileId,
      set: { state: 'pending', attempts: 0, nextAttemptAt: sql`now()`, lastError: null, updatedAt: new Date() },
      setWhere: sql`${federatedMediaDeletions.state} = 'in_use'`,
    })
    .returning({ id: federatedMediaDeletions.id });
  return written.length;
}

/** Record the poster frame Oxy-hosted for a re-hosted video (idempotent). */
export async function recordFederatedPoster(
  videoFileId: string,
  posterFileId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .insert(federatedMediaPosters)
    .values({ videoFileId, posterFileId })
    .onConflictDoNothing();
}

export interface DueMediaDeletion {
  oxyFileId: string;
  state: 'pending' | 'deleting';
  attempts: number;
}

/** Rows whose next attempt is due, oldest first. */
export async function findDueMediaDeletions(limit: number, db: DatabaseOrTransaction = getDb()): Promise<DueMediaDeletion[]> {
  const rows = await db
    .select({
      oxyFileId: federatedMediaDeletions.oxyFileId,
      state: federatedMediaDeletions.state,
      attempts: federatedMediaDeletions.attempts,
    })
    .from(federatedMediaDeletions)
    .where(and(
      inArray(federatedMediaDeletions.state, ['pending', 'deleting']),
      lte(federatedMediaDeletions.nextAttemptAt, sql`now()`),
    ))
    .orderBy(asc(federatedMediaDeletions.nextAttemptAt))
    .limit(limit);
  return rows as DueMediaDeletion[];
}

/**
 * Which of `fileIds` Mention still references anywhere: a post's media, a
 * variant's media, a federated profile banner — or, for a poster, a still
 * referenced video it belongs to. Batched: one statement per table.
 */
async function referencedFileIds(tx: DatabaseOrTransaction, fileIds: readonly string[]): Promise<Set<string>> {
  const ids = [...fileIds];
  const used = new Set<string>();
  const add = (rows: Array<{ id: string | null }>) => rows.forEach((row) => row.id && used.add(row.id));

  add(await tx.select({ id: postMedia.mediaId }).from(postMedia).where(inArray(postMedia.mediaId, ids)));
  add(await tx.select({ id: postVariantMedia.mediaId }).from(postVariantMedia).where(inArray(postVariantMedia.mediaId, ids)));
  add(await tx.select({ id: userSettings.profileHeaderImage }).from(userSettings).where(inArray(userSettings.profileHeaderImage, ids)));

  // A poster is in use while ANY video it belongs to is.
  const posterOf = await tx
    .select({ poster: federatedMediaPosters.posterFileId, video: federatedMediaPosters.videoFileId })
    .from(federatedMediaPosters)
    .where(inArray(federatedMediaPosters.posterFileId, ids));
  if (posterOf.length > 0) {
    const videos = [...new Set(posterOf.map((row) => row.video))];
    const liveVideos = new Set<string>();
    const addVideo = (rows: Array<{ id: string | null }>) => rows.forEach((row) => row.id && liveVideos.add(row.id));
    addVideo(await tx.select({ id: postMedia.mediaId }).from(postMedia).where(inArray(postMedia.mediaId, videos)));
    addVideo(await tx.select({ id: postVariantMedia.mediaId }).from(postVariantMedia).where(inArray(postVariantMedia.mediaId, videos)));
    for (const row of posterOf) if (liveVideos.has(row.video)) used.add(row.poster);
  }
  return used;
}

/**
 * Decide the `pending` rows of a batch under their locks: still referenced →
 * `in_use`; otherwise → `deleting` (the tombstone), and the video's posters are
 * queued in turn. Returns the ids now tombstoned.
 */
export async function tombstoneUnreferenced(fileIds: readonly string[]): Promise<string[]> {
  if (fileIds.length === 0) return [];
  return getDb().transaction(async (tx) => {
    await lockFiles(tx, fileIds);
    // Re-read under the lock: another drain may have decided some already.
    const rows = await tx
      .select({ oxyFileId: federatedMediaDeletions.oxyFileId })
      .from(federatedMediaDeletions)
      .where(and(inArray(federatedMediaDeletions.oxyFileId, [...fileIds]), eq(federatedMediaDeletions.state, 'pending')));
    const pending = rows.map((row) => row.oxyFileId);
    if (pending.length === 0) return [];

    const used = await referencedFileIds(tx, pending);
    const inUse = pending.filter((id) => used.has(id));
    const unused = pending.filter((id) => !used.has(id));
    if (inUse.length > 0) {
      await tx.update(federatedMediaDeletions)
        .set({ state: 'in_use', updatedAt: new Date() })
        .where(inArray(federatedMediaDeletions.oxyFileId, inUse));
    }
    if (unused.length > 0) {
      await tx.update(federatedMediaDeletions)
        .set({ state: 'deleting', nextAttemptAt: sql`now()`, updatedAt: new Date() })
        .where(inArray(federatedMediaDeletions.oxyFileId, unused));
      const posters = await tx
        .select({ poster: federatedMediaPosters.posterFileId })
        .from(federatedMediaPosters)
        .where(inArray(federatedMediaPosters.videoFileId, unused));
      await enqueueFederatedMediaDeletions([...new Set(posters.map((row) => row.poster))], tx);
    }
    return unused;
  });
}

/** Oxy answered for these files: final states. */
export async function settleMediaDeletions(
  results: ReadonlyArray<{ oxyFileId: string; result: 'deleted' | 'not_found' | 'forbidden' }>,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  for (const state of ['deleted', 'not_found', 'forbidden'] as const) {
    const ids = results.filter((row) => row.result === state).map((row) => row.oxyFileId);
    if (ids.length === 0) continue;
    await db.update(federatedMediaDeletions)
      .set({ state, lastError: null, updatedAt: new Date() })
      .where(and(inArray(federatedMediaDeletions.oxyFileId, ids), eq(federatedMediaDeletions.state, 'deleting')));
  }
}

/** The attempt failed for a reason that may pass: try again after `delayMs`. */
export async function retryMediaDeletions(
  fileIds: readonly string[],
  delayMs: number,
  reason: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  if (fileIds.length === 0) return;
  await db.update(federatedMediaDeletions)
    .set({
      attempts: sql`${federatedMediaDeletions.attempts} + 1`,
      nextAttemptAt: sql`now() + (${delayMs} * interval '1 millisecond')`,
      lastError: reason.slice(0, 200),
      updatedAt: new Date(),
    })
    .where(and(
      inArray(federatedMediaDeletions.oxyFileId, [...fileIds]),
      or(eq(federatedMediaDeletions.state, 'deleting'), eq(federatedMediaDeletions.state, 'pending')),
      isNotNull(federatedMediaDeletions.oxyFileId),
    ));
}
