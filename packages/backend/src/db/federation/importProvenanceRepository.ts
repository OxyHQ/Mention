import { and, eq, inArray, isNotNull, min } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { federatedActors } from '../schema/federation';
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

/** The reasons a post is stored because Mention follows its author: delivery. */
const SUBSCRIPTION_REASONS: readonly FederationImportReason[] = ['inbox_follow', 'inbox_announce'];

/**
 * When the transports of `networkAcct` on `hosts` began delivering it by
 * subscription: the publication time of the earliest post (a boost included)
 * Mention stored from one of those actors because it follows them, or null
 * when none was ever stored that way. Posts fetched as a reply parent, a quote
 * or a boosted original do not count: they say nothing about whether the
 * account's stream is covered.
 */
export async function subscribedSinceForAccount(
  networkAcct: string,
  hosts: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Date | null> {
  if (hosts.length === 0) return null;
  const [row] = await db
    .select({ since: min(posts.createdAt) })
    .from(posts)
    .innerJoin(federatedActors, eq(federatedActors.uri, posts.federationActorUri))
    .innerJoin(federationPostImports, eq(federationPostImports.postId, posts.id))
    .where(
      and(
        eq(federatedActors.networkAcct, networkAcct),
        inArray(federatedActors.domain, [...hosts]),
        inArray(federationPostImports.initialReason, [...SUBSCRIPTION_REASONS]),
      ),
    );
  return row?.since ?? null;
}
