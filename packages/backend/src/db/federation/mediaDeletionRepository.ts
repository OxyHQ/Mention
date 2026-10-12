import { and, asc, eq, inArray, isNotNull, lt, lte, or, sql } from 'drizzle-orm';
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

/** How long a revived file waits before the drain re-checks its references. */
const REVIVE_GRACE_MS = 60 * 60 * 1000;

/** Terminal `forbidden` rows are kept this long for diagnosis, then pruned. */
const FORBIDDEN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** A file this app no longer references is being, or has been, deleted in Oxy. */
const TOMBSTONE_STATES = ['deleting', 'deleted', 'not_found'] as const;

/**
 * Take the per-file locks (`hashtext('federated-media:<id>')`) in a fixed order,
 * so two multi-file transactions cannot deadlock — in ONE statement, however
 * many files: a post insert and every drain batch take these, and a round trip
 * per id made both scale with the media count. The keys are sorted here, and
 * `unnest … with ordinality` emits them in array order (the planner knows the
 * scan is ordered by `n`, so no sort sits between it and the lock calls).
 */
async function lockFiles(tx: DatabaseOrTransaction, fileIds: readonly string[]): Promise<void> {
  const keys = [...new Set(fileIds)].sort().map((id) => `federated-media:${id}`);
  if (keys.length === 0) return;
  await tx.execute(sql`
    select pg_advisory_xact_lock(hashtext(t.key))
    from unnest(array[${sql.join(
      keys.map((key) => sql`${key}`),
      sql`, `,
    )}]::text[]) with ordinality as t(key, n)
    order by t.n
  `);
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
 * Inside the post insert's transaction: lock EVERY media id the post will
 * reference (a per-file advisory lock is cheap, and a caller's
 * `cachedFromFederation` flag is not what decides whether an id is shared) and
 * return the ones that are tombstoned. The locks are held to commit, so the
 * drain cannot tombstone one between this check and the media rows landing.
 */
export async function findGoneFederatedMedia(
  tx: DatabaseOrTransaction,
  requested: readonly (string | null | undefined)[],
): Promise<Set<string>> {
  // Items without an id (a stored remote-only item, legacy input) reference no
  // Oxy file: nothing to lock or check.
  const fileIds = [
    ...new Set(requested.filter((id): id is string => typeof id === 'string' && id.length > 0)),
  ];
  if (fileIds.length === 0) return new Set();
  await lockFiles(tx, fileIds);
  const gone = await tx
    .select({ oxyFileId: federatedMediaDeletions.oxyFileId })
    .from(federatedMediaDeletions)
    .where(
      and(
        inArray(federatedMediaDeletions.oxyFileId, fileIds),
        inArray(federatedMediaDeletions.state, [...TOMBSTONE_STATES]),
      ),
    );
  return new Set(gone.map((row) => row.oxyFileId));
}

/** {@link findGoneFederatedMedia}, refusing (throwing) when any id is tombstoned. */
export async function assertFederatedMediaUsable(
  tx: DatabaseOrTransaction,
  fileIds: readonly string[],
): Promise<void> {
  const gone = await findGoneFederatedMedia(tx, fileIds);
  if (gone.size > 0) throw new FederatedMediaGoneError([...gone]);
}

/**
 * The DATABASE clock, for instants compared with `settled_at` (also written by
 * the database): a JS clock skewed against it could make an upload that
 * overlapped a delete look like it started after it.
 */
export async function databaseNow(db: DatabaseOrTransaction = getDb()): Promise<Date> {
  const [row] = await db.execute<{ now: string | Date }>(sql`select clock_timestamp() as now`);
  return new Date(row.now);
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
    .where(
      and(
        inArray(postContentVariants.postId, ids),
        eq(postVariantMedia.cachedFromFederation, true),
      ),
    );
  const fileIds = [...new Set([...rows, ...variantRows].map((row) => row.mediaId))];
  return enqueueFederatedMediaDeletions(fileIds, db);
}

/** The re-hosted federated file ids a post references (its media and its variants' media). */
export async function federatedMediaIdsOfPost(
  db: DatabaseOrTransaction,
  postId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ mediaId: postMedia.mediaId })
    .from(postMedia)
    .where(and(eq(postMedia.postId, postId), eq(postMedia.cachedFromFederation, true)));
  const variantRows = await db
    .select({ mediaId: postVariantMedia.mediaId })
    .from(postVariantMedia)
    .innerJoin(postContentVariants, eq(postContentVariants.id, postVariantMedia.variantId))
    .where(
      and(eq(postContentVariants.postId, postId), eq(postVariantMedia.cachedFromFederation, true)),
    );
  return new Set([...rows, ...variantRows].map((row) => row.mediaId));
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
      set: {
        state: 'pending',
        attempts: 0,
        nextAttemptAt: sql`now()`,
        lastError: null,
        updatedAt: new Date(),
      },
      // Re-arm a file kept as `in_use`, or a `pending` row with no failed
      // attempts that is already due. A revived file waits out its grace period
      // (`next_attempt_at` in the future): pulling it to now would delete it
      // under the import that is about to reference it (upload/delete churn).
      // A tombstone, and a row backing off after failures, stay as they are.
      setWhere: sql`${federatedMediaDeletions.state} = 'in_use'
        or (${federatedMediaDeletions.state} = 'pending'
            and ${federatedMediaDeletions.attempts} = 0
            and ${federatedMediaDeletions.nextAttemptAt} <= now())`,
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
export async function findDueMediaDeletions(
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<DueMediaDeletion[]> {
  const rows = await db
    .select({
      oxyFileId: federatedMediaDeletions.oxyFileId,
      state: federatedMediaDeletions.state,
      attempts: federatedMediaDeletions.attempts,
    })
    .from(federatedMediaDeletions)
    .where(
      and(
        inArray(federatedMediaDeletions.state, ['pending', 'deleting']),
        lte(federatedMediaDeletions.nextAttemptAt, sql`now()`),
      ),
    )
    .orderBy(asc(federatedMediaDeletions.nextAttemptAt))
    .limit(limit);
  return rows as DueMediaDeletion[];
}

/**
 * Which of `fileIds` Mention still references anywhere: a post's media, a
 * variant's media, a federated profile banner — or, for a poster, a still
 * referenced video it belongs to. Batched: one statement per table.
 */
async function referencedFileIds(
  tx: DatabaseOrTransaction,
  fileIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...fileIds];
  const used = new Set<string>();
  const add = (rows: Array<{ id: string | null }>) =>
    rows.forEach((row) => row.id && used.add(row.id));

  add(
    await tx
      .select({ id: postMedia.mediaId })
      .from(postMedia)
      .where(inArray(postMedia.mediaId, ids)),
  );
  add(
    await tx
      .select({ id: postVariantMedia.mediaId })
      .from(postVariantMedia)
      .where(inArray(postVariantMedia.mediaId, ids)),
  );
  add(
    await tx
      .select({ id: userSettings.profileHeaderImage })
      .from(userSettings)
      .where(inArray(userSettings.profileHeaderImage, ids)),
  );

  // A poster is in use while ANY video it belongs to is.
  const posterOf = await tx
    .select({
      poster: federatedMediaPosters.posterFileId,
      video: federatedMediaPosters.videoFileId,
    })
    .from(federatedMediaPosters)
    .where(inArray(federatedMediaPosters.posterFileId, ids));
  if (posterOf.length > 0) {
    const videos = [...new Set(posterOf.map((row) => row.video))];
    const liveVideos = new Set<string>();
    const addVideo = (rows: Array<{ id: string | null }>) =>
      rows.forEach((row) => row.id && liveVideos.add(row.id));
    addVideo(
      await tx
        .select({ id: postMedia.mediaId })
        .from(postMedia)
        .where(inArray(postMedia.mediaId, videos)),
    );
    addVideo(
      await tx
        .select({ id: postVariantMedia.mediaId })
        .from(postVariantMedia)
        .where(inArray(postVariantMedia.mediaId, videos)),
    );
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
      .where(
        and(
          inArray(federatedMediaDeletions.oxyFileId, [...fileIds]),
          eq(federatedMediaDeletions.state, 'pending'),
        ),
      );
    const pending = rows.map((row) => row.oxyFileId);
    if (pending.length === 0) return [];

    const used = await referencedFileIds(tx, pending);
    const inUse = pending.filter((id) => used.has(id));
    const unused = pending.filter((id) => !used.has(id));
    if (inUse.length > 0) {
      await tx
        .update(federatedMediaDeletions)
        .set({ state: 'in_use', updatedAt: new Date() })
        .where(inArray(federatedMediaDeletions.oxyFileId, inUse));
    }
    if (unused.length > 0) {
      await tx
        .update(federatedMediaDeletions)
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

/**
 * Oxy answered for these files: final states. Oxy's `in_use` (the file is also
 * held by another owner or app, so Oxy keeps it) settles as `in_use` here too —
 * the file is live, NOT a tombstone, and a later deletion re-arms it.
 */
export async function settleMediaDeletions(
  results: ReadonlyArray<{
    oxyFileId: string;
    result: 'deleted' | 'not_found' | 'forbidden' | 'in_use';
  }>,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  for (const state of ['deleted', 'not_found', 'forbidden', 'in_use'] as const) {
    const ids = results.filter((row) => row.result === state).map((row) => row.oxyFileId);
    if (ids.length === 0) continue;
    await db
      .update(federatedMediaDeletions)
      .set({ state, lastError: null, settledAt: sql`now()`, updatedAt: new Date() })
      .where(
        and(
          inArray(federatedMediaDeletions.oxyFileId, ids),
          eq(federatedMediaDeletions.state, 'deleting'),
        ),
      );
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
  await db
    .update(federatedMediaDeletions)
    .set({
      attempts: sql`${federatedMediaDeletions.attempts} + 1`,
      nextAttemptAt: sql`now() + (${delayMs} * interval '1 millisecond')`,
      lastError: reason.slice(0, 200),
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(federatedMediaDeletions.oxyFileId, [...fileIds]),
        or(
          eq(federatedMediaDeletions.state, 'deleting'),
          eq(federatedMediaDeletions.state, 'pending'),
        ),
        isNotNull(federatedMediaDeletions.oxyFileId),
      ),
    );
}

/**
 * An upload of re-hosted federated media returned these ids. Oxy dedupes by
 * content hash and REACTIVATES a trashed file under its old id, so an id this
 * app has deleted can come back live. Lift the tombstone — but only when the
 * upload STARTED after Oxy confirmed the delete (`settled_at`): then the delete
 * certainly happened first and the upload brought the file back. An upload that
 * may have overlapped the delete (or a delete still in flight, `deleting`)
 * leaves the tombstone in place; the post insert refuses the id and the import
 * retries, and its next upload starts after the settle.
 *
 * A lifted row goes back to `pending` with its next attempt a grace period
 * away — NOT straight to `in_use` — because the upload that revived the file is
 * not yet a reference: if the insert that was going to use it fails, the drain
 * finds the file unreferenced after the grace period and deletes it again,
 * instead of leaking a live file nothing points at.
 *
 * Under the same per-file lock the drain and the insert take.
 */
export async function reviveFederatedFiles(
  fileIds: readonly string[],
  uploadStartedAt: Date,
): Promise<string[]> {
  if (fileIds.length === 0) return [];
  return getDb().transaction(async (tx) => {
    await lockFiles(tx, fileIds);
    const revived = await tx
      .update(federatedMediaDeletions)
      .set({
        state: 'pending',
        attempts: 0,
        nextAttemptAt: sql`now() + (${REVIVE_GRACE_MS} * interval '1 millisecond')`,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(federatedMediaDeletions.oxyFileId, [...fileIds]),
          inArray(federatedMediaDeletions.state, ['deleted', 'not_found']),
          lt(federatedMediaDeletions.settledAt, sql`${uploadStartedAt.toISOString()}::timestamptz`),
        ),
      )
      .returning({ oxyFileId: federatedMediaDeletions.oxyFileId });
    return revived.map((row) => row.oxyFileId);
  });
}

/**
 * Bounded housekeeping, run by the drain:
 *  - terminal `forbidden` rows (never this app's file — no tombstone meaning)
 *    past {@link FORBIDDEN_RETENTION_MS};
 *  - poster pairs whose video is gone (tombstoned) and whose poster has already
 *    been queued: the pair can no longer keep the poster alive or queue it.
 * Tombstones themselves stay, by design.
 */
export async function pruneFederatedMediaHousekeeping(
  limit = 500,
): Promise<{ forbidden: number; posterPairs: number }> {
  const forbidden = await getDb().execute<{ id: string }>(sql`
    delete from ${federatedMediaDeletions}
    where ${federatedMediaDeletions.id} in (
      select ${federatedMediaDeletions.id} from ${federatedMediaDeletions}
      where ${federatedMediaDeletions.state} = 'forbidden'
        and ${federatedMediaDeletions.updatedAt} < now() - (${FORBIDDEN_RETENTION_MS} * interval '1 millisecond')
      limit ${limit}
    )
    returning ${federatedMediaDeletions.id}
  `);
  const posterPairs = await getDb().execute<{ id: string }>(sql`
    delete from ${federatedMediaPosters}
    where ${federatedMediaPosters.id} in (
      select pair.id from ${federatedMediaPosters} pair
      join ${federatedMediaDeletions} video on video.oxy_file_id = pair.video_file_id
      join ${federatedMediaDeletions} poster on poster.oxy_file_id = pair.poster_file_id
      where video.state in ('deleting', 'deleted', 'not_found')
      limit ${limit}
    )
    returning ${federatedMediaPosters.id}
  `);
  return { forbidden: [...forbidden].length, posterPairs: [...posterPairs].length };
}

/** Rows whose attempts reached `threshold`: a deletion Oxy keeps refusing to answer. */
export async function countStuckMediaDeletions(
  threshold: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db.execute<{ stuck: number }>(sql`
    select count(*)::int as stuck from ${federatedMediaDeletions}
    where ${federatedMediaDeletions.state} in ('pending', 'deleting')
      and ${federatedMediaDeletions.attempts} >= ${threshold}
  `);
  return Number(row?.stuck ?? 0);
}
