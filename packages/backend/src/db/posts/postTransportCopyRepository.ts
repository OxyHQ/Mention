import { qualified } from '@oxy.so/db';
import { and, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { postTransportCopies, type TransportCopyFacts } from '../schema/postContent';
import { posts } from '../schema/posts';

/** One transport copy of a post — see `postTransportCopies`. */
export interface TransportCopyRow {
  objectUri: string;
  actorUri: string;
  facts: TransportCopyFacts;
}

/** Every recorded copy of `postId`; empty for a post only one transport ever delivered. */
export async function loadTransportCopies(
  postId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<TransportCopyRow[]> {
  return db
    .select({
      objectUri: postTransportCopies.objectUri,
      actorUri: postTransportCopies.actorUri,
      facts: postTransportCopies.facts,
    })
    .from(postTransportCopies)
    .where(eq(postTransportCopies.postId, postId));
}

/** Record (or replace, on an edit) what each copy says. */
export async function upsertTransportCopies(
  postId: string,
  copies: readonly TransportCopyRow[],
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  if (copies.length === 0) return;
  await db
    .insert(postTransportCopies)
    .values(copies.map((copy) => ({ ...copy, postId })))
    .onConflictDoUpdate({
      target: postTransportCopies.objectUri,
      set: { facts: sql`excluded.facts`, updatedAt: sql`now()` },
    });
}

/** The URIs of `objectUris` that are already recorded as a copy of some post. */
export async function findRecordedTransportCopies(
  objectUris: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Set<string>> {
  if (objectUris.length === 0) return new Set();
  const rows = await db
    .select({ objectUri: postTransportCopies.objectUri })
    .from(postTransportCopies)
    .where(inArray(postTransportCopies.objectUri, [...objectUris]));
  return new Set(rows.map((row) => row.objectUri));
}

/** The recorded copies among `objectUris`, with the post each belongs to. */
export async function findTransportCopies(
  objectUris: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<Array<{ objectUri: string; postId: string; actorUri: string }>> {
  if (objectUris.length === 0) return [];
  return db
    .select({
      objectUri: postTransportCopies.objectUri,
      postId: postTransportCopies.postId,
      actorUri: postTransportCopies.actorUri,
    })
    .from(postTransportCopies)
    .where(inArray(postTransportCopies.objectUri, [...objectUris]));
}

/**
 * Remove the copy `objectUri` of `postId` when ANOTHER copy still asserts the
 * post. True when it did — the post stays; false when this was the last (or
 * only) copy, and the caller deletes the post as before.
 */
export async function releaseTransportCopy(
  postId: string,
  objectUri: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const others = await db
    .select({ objectUri: postTransportCopies.objectUri })
    .from(postTransportCopies)
    .where(
      and(eq(postTransportCopies.postId, postId), ne(postTransportCopies.objectUri, objectUri)),
    )
    .limit(1);
  if (others.length === 0) return false;
  await db.delete(postTransportCopies).where(eq(postTransportCopies.objectUri, objectUri));
  return true;
}

/**
 * "`actorUri` delivered this post": it is the post's own actor, or it delivered a
 * copy recorded for it. What an Update or a Delete from a transport is scoped
 * by, so one remote actor can never edit or remove another's post.
 */
export function deliveredByActorSql(actorUri: string): SQL {
  return or(
    eq(posts.federationActorUri, actorUri),
    sql`exists (select 1 from ${postTransportCopies} where ${qualified(postTransportCopies.postId)} = ${qualified(posts.id)} and ${qualified(postTransportCopies.actorUri)} = ${actorUri})`,
  ) as SQL;
}

/** The provenance fields a merge may change on the post row. */
export interface MergedProvenancePatch {
  createdAt?: Date;
  federationUrl?: string | null;
  federationInReplyTo?: string | null;
  federationSpoilerText?: string | null;
  federationSensitive?: boolean;
  metadataIsSensitive?: boolean;
  quoteOf?: string | null;
  isReply?: boolean;
  language?: string | null;
  isEdited?: boolean;
}

/** Write a merge's provenance fields; a no-op for an empty patch. */
export async function updateMergedProvenance(
  postId: string,
  patch: MergedProvenancePatch,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const values = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as MergedProvenancePatch;
  if (Object.keys(values).length === 0) return;
  await db.update(posts).set(values).where(eq(posts.id, postId));
}
