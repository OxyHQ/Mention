import { and, inArray, isNotNull } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { posts } from '../schema/posts';
import {
  federationPostImports,
  federationPostImportReasons,
  type FederationImportReason,
} from '../schema/federationImports';

/** Called only by the transaction that inserted the post; never upserts origin. */
export async function recordNewFederationImport(
  postId: string,
  reason: FederationImportReason,
  db: DatabaseOrTransaction,
): Promise<void> {
  await db.insert(federationPostImports).values({ postId, initialReason: reason });
  await db.insert(federationPostImportReasons).values({ postId, reason });
}

/**
 * Retain a later reason to hold existing federated posts without rewriting their
 * first import. Legacy posts keep a NULL origin, even if their reason is known now.
 * The enum and composite key bound storage to eleven reason rows per post.
 */
export async function observeFederationImportReason(
  postIds: readonly string[],
  reason: FederationImportReason,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const uniqueIds = [...new Set(postIds)];
  if (uniqueIds.length === 0) return;
  const write = async (tx: DatabaseOrTransaction): Promise<void> => {
    // Hold row locks until evidence is inserted, so a concurrent Delete cannot
    // remove the parent between this read and the FK insert.
    const eligible = await tx
      .select({ id: posts.id })
      .from(posts)
      .where(and(inArray(posts.id, uniqueIds), isNotNull(posts.federationActorUri)))
      .for('key share');
    if (eligible.length === 0) return;
    await tx
      .insert(federationPostImports)
      .values(eligible.map(({ id }) => ({ postId: id })))
      .onConflictDoNothing();
    await tx
      .insert(federationPostImportReasons)
      .values(eligible.map(({ id }) => ({ postId: id, reason })))
      .onConflictDoNothing();
  };
  if ('transaction' in db) await db.transaction(write);
  else await write(db);
}
