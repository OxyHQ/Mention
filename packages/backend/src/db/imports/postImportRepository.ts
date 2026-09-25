/**
 * Reads and writes of `post_imports`, the import ledger (see `schema/imports.ts`).
 *
 * Every query here is scoped by the table's own keys — the unique
 * `(oxy_user_id, platform, source_id)`, the `import_batch_id` index or the
 * `post_id` primary key — so none of them scans.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { ImportPlatform, PostImportProvenance } from '@mention/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { postImports } from '../schema/imports';
import { posts } from '../schema/posts';

export interface PostImportRow {
  postId: string;
  oxyUserId: string;
  platform: ImportPlatform;
  sourceId: string;
  sourceUrl: string;
  contentWarning: string | null;
  importBatchId: string;
  importedAt: Date;
}

/** What hydration needs from the ledger for one post. */
export interface PostImportHydration extends PostImportProvenance {
  contentWarning?: string;
}

/**
 * The ledger rows of `sourceIds` that `oxyUserId` already imported from
 * `platform`, keyed by source id. Ids never imported are simply absent.
 */
export async function findImportsBySourceIds(
  oxyUserId: string,
  platform: ImportPlatform,
  sourceIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, PostImportRow>> {
  const unique = [...new Set(sourceIds)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({
      postId: postImports.postId,
      oxyUserId: postImports.oxyUserId,
      platform: postImports.platform,
      sourceId: postImports.sourceId,
      sourceUrl: postImports.sourceUrl,
      contentWarning: postImports.contentWarning,
      importBatchId: postImports.importBatchId,
      importedAt: postImports.importedAt,
    })
    .from(postImports)
    .where(and(
      eq(postImports.oxyUserId, oxyUserId),
      eq(postImports.platform, platform),
      inArray(postImports.sourceId, unique),
    ));
  return new Map(rows.map((row) => [row.sourceId, row]));
}

/**
 * Record that `row.postId` is the import of a source item.
 *
 * Returns `false`, writing nothing, when the SAME source item was recorded by a
 * concurrent request first — the unique key decides, never a read beforehand, so
 * two racing sends cannot both believe they own the item. The caller then owns
 * a duplicate post and must remove it.
 */
export async function insertPostImport(
  row: Omit<PostImportRow, 'importedAt'>,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const inserted = await db
    .insert(postImports)
    .values(row)
    .onConflictDoNothing({
      target: [postImports.oxyUserId, postImports.platform, postImports.sourceId],
    })
    .returning({ postId: postImports.postId });
  return inserted.length > 0;
}

/**
 * The posts `oxyUserId` imported in batch `importBatchId`, NEWEST FIRST.
 *
 * Newest first because deleting a post removes its reply subtree with it and
 * only federates a Delete for the post itself: walking replies before their
 * parents gives every imported post its own Delete. Scoped by the owner as well
 * as the batch, so a batch id guessed or reused by another account reaches
 * nothing of this one.
 */
export async function findBatchPostIds(
  oxyUserId: string,
  importBatchId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ postId: postImports.postId })
    .from(postImports)
    .innerJoin(posts, eq(posts.id, postImports.postId))
    .where(and(
      eq(postImports.importBatchId, importBatchId),
      eq(postImports.oxyUserId, oxyUserId),
    ))
    .orderBy(desc(posts.createdAt), desc(posts.id));
  return rows.map((row) => row.postId);
}

/**
 * Import provenance for a page of posts, in ONE query, keyed by post id. Posts
 * that were not imported are absent.
 */
export async function loadImportProvenance(
  postIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Map<string, PostImportHydration>> {
  const unique = [...new Set(postIds)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({
      postId: postImports.postId,
      platform: postImports.platform,
      sourceUrl: postImports.sourceUrl,
      contentWarning: postImports.contentWarning,
    })
    .from(postImports)
    .where(inArray(postImports.postId, unique));
  return new Map(rows.map((row) => [row.postId, {
    platform: row.platform,
    sourceUrl: row.sourceUrl,
    ...(row.contentWarning ? { contentWarning: row.contentWarning } : {}),
  }]));
}

/** A federated post Mention already holds, as the import lookup reports it. */
export interface FederatedCopyRow {
  activityId: string;
  postId: string;
  actorUri: string | null;
  url: string | null;
  oxyUserId: string | null;
}

/**
 * Public, published federated posts whose AS2 object id / at-uri is one of
 * `activityIds` — the copies of an account's old posts that federation ingested
 * before the account moved. Public only: before the Move they are not the
 * caller's, so nothing is reported that any reader could not see.
 * `posts_federation_activity_id_key` is unique, so this is an index lookup per id.
 */
export async function findFederatedCopies(
  activityIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<FederatedCopyRow[]> {
  const unique = [...new Set(activityIds)];
  if (unique.length === 0) return [];
  const rows = await db
    .select({
      activityId: posts.federationActivityId,
      postId: posts.id,
      actorUri: posts.federationActorUri,
      url: posts.federationUrl,
      oxyUserId: posts.oxyUserId,
    })
    .from(posts)
    .where(and(
      inArray(posts.federationActivityId, unique),
      eq(posts.status, 'published'),
      eq(posts.visibility, 'public'),
    ));
  return rows.flatMap((row) => (row.activityId ? [{ ...row, activityId: row.activityId }] : []));
}
