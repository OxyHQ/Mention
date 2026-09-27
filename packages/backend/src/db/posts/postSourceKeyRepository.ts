import { and, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { postSourceKeys } from '../schema/postContent';

/**
 * Claims on `post_source_keys` — see the table's docblock.
 *
 * A writer that must do slow, irreversible work BEFORE inserting a post (the
 * Graph import downloads and re-hosts media, and oxy-api has no route to delete
 * a durable federation asset again) claims the key first. A racing writer then
 * collides on the claim — the bridge ingest retries, finding the finished post —
 * instead of both uploading and one upload being orphaned.
 */

/**
 * Claim `sourceKey` until `until`. True when this caller now holds it: the key
 * was free, or its previous claim expired. False when it is filled (the post
 * exists) or claimed by a live holder.
 */
export async function claimSourceKey(
  sourceKey: string,
  claimToken: string,
  until: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const inserted = await db
    .insert(postSourceKeys)
    .values({ sourceKey, claimToken, claimedUntil: until })
    .onConflictDoNothing({ target: postSourceKeys.sourceKey })
    .returning({ id: postSourceKeys.id });
  if (inserted.length > 0) return true;
  const taken = await db
    .update(postSourceKeys)
    .set({ claimToken, claimedUntil: until })
    .where(and(
      eq(postSourceKeys.sourceKey, sourceKey),
      isNull(postSourceKeys.postId),
      lt(postSourceKeys.claimedUntil, sql`now()`),
    ))
    .returning({ id: postSourceKeys.id });
  return taken.length > 0;
}

/** Drop this caller's claim if it was never filled (the import gave up). */
export async function releaseSourceKeyClaim(
  sourceKey: string,
  claimToken: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .delete(postSourceKeys)
    .where(and(
      eq(postSourceKeys.sourceKey, sourceKey),
      isNull(postSourceKeys.postId),
      eq(postSourceKeys.claimToken, claimToken),
    ));
}

/**
 * Source keys (of `keys`) that are FILLED — the post exists. A key that is only
 * claimed is not "known": its import may still fail and release it, so a sync
 * must not treat it as history it has already walked (the claim itself makes a
 * second importer skip it).
 */
export async function findFilledSourceKeys(
  keys: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await db
    .select({ sourceKey: postSourceKeys.sourceKey })
    .from(postSourceKeys)
    .where(and(inArray(postSourceKeys.sourceKey, [...keys]), isNotNull(postSourceKeys.postId)));
  return new Set(rows.map((row) => row.sourceKey));
}
