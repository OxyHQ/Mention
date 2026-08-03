/**
 * The ONE read/write path for `threadgates` (who may reply) and `postgates`
 * (who may quote).
 *
 * ## Where the false answer points
 *
 * Both are REQUEST-path stores with no background reader: every route here
 * answers a user who is looking at the result. A gate that stopped being written
 * would surface as `404 Threadgate not found` on a gate the author had just set
 * — visible immediately, to the one person who would report it. That is why
 * these are ordinary repository functions and not something louder.
 *
 * ## `allow[]` is a child table, and the invariant it made expressible
 *
 * Mongo embedded `{ type, list? }` objects and validated neither side of the
 * pairing, so a `listOnly` rule with no list (matches nobody, silently) and a
 * `followingOnly` rule carrying a stray list were both storable.
 * `threadgate_allow_rules_list_id_check` refuses both. Since the payload comes
 * straight from a client, {@link parseThreadgateAllowRules} rejects it BEFORE
 * the insert so the route can answer `400` — a CHECK violation surfacing as a
 * `500` would blame the server for a malformed request.
 *
 * Rules are written by POSITION rather than deleted and re-inserted: the client
 * sends the whole list, but a wholesale replace would hand every surviving rule
 * a new row id on each edit.
 */

import { and, asc, eq, gte, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import {
  postgates,
  threadgateAllowRules,
  threadgates,
  THREADGATE_ALLOW_TYPES,
} from '../schema/gates';

/** One `allow[]` entry. `list` is present exactly when the type is `listOnly`. */
export interface ThreadgateAllowRule {
  type: (typeof THREADGATE_ALLOW_TYPES)[number];
  list?: string;
}

/** A stored reply-control gate. */
export interface ThreadgateRecord {
  id: string;
  postUri: string;
  postId: string;
  allow: ThreadgateAllowRule[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A stored quote-control gate. */
export interface PostgateRecord {
  id: string;
  postUri: string;
  postId: string;
  disableQuotes: boolean;
  detachedQuoteUris: string[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Validate a client-supplied `allow` payload.
 *
 * @returns The parsed rules, or `null` when the payload cannot be stored — an
 *   unknown rule type, a `listOnly` rule with no list, or a list on a rule that
 *   is not `listOnly`. An absent payload is an empty list, matching the route's
 *   previous `allow || []`.
 */
export function parseThreadgateAllowRules(value: unknown): ThreadgateAllowRule[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;

  const rules: ThreadgateAllowRule[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { type, list } = entry as { type?: unknown; list?: unknown };
    if (typeof type !== 'string') return null;
    if (!(THREADGATE_ALLOW_TYPES as readonly string[]).includes(type)) return null;

    const hasList = typeof list === 'string' && list.length > 0;
    if (list !== undefined && list !== null && !hasList) return null;
    if ((type === 'listOnly') !== hasList) return null;

    rules.push(
      hasList
        ? { type: type as ThreadgateAllowRule['type'], list }
        : { type: type as ThreadgateAllowRule['type'] },
    );
  }
  return rules;
}

/** Validate a client-supplied `detachedQuoteUris` payload. */
export function parseDetachedQuoteUris(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  if (value.some((uri) => typeof uri !== 'string')) return null;
  return value as string[];
}

/** Read a threadgate's rules, in their stored order. */
async function loadAllowRules(
  threadgateId: string,
  db: DatabaseOrTransaction,
): Promise<ThreadgateAllowRule[]> {
  const rows = await db
    .select({ type: threadgateAllowRules.type, listId: threadgateAllowRules.listId })
    .from(threadgateAllowRules)
    .where(eq(threadgateAllowRules.threadgateId, threadgateId))
    .orderBy(asc(threadgateAllowRules.position));
  return rows.map((row) => (row.listId === null ? { type: row.type } : { type: row.type, list: row.listId }));
}

/**
 * Create or replace the reply-control gate for `postUri`.
 *
 * Upserts on `post_uri`, matching the `{ upsert: true, new: true }` the route
 * used, and REPLACES the rule list — the client always sends it complete.
 */
export async function upsertThreadgate(
  gate: { postUri: string; postId: string; createdBy: string; allow: readonly ThreadgateAllowRule[] },
): Promise<ThreadgateRecord> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .insert(threadgates)
      .values({ postUri: gate.postUri, postId: gate.postId, createdBy: gate.createdBy })
      .onConflictDoUpdate({
        target: threadgates.postUri,
        set: { postId: gate.postId, createdBy: gate.createdBy, updatedAt: new Date() },
      })
      .returning();

    if (gate.allow.length > 0) {
      await tx
        .insert(threadgateAllowRules)
        .values(
          gate.allow.map((rule, position) => ({
            threadgateId: row.id,
            position,
            type: rule.type,
            listId: rule.list ?? null,
          })),
        )
        .onConflictDoUpdate({
          target: [threadgateAllowRules.threadgateId, threadgateAllowRules.position],
          set: { type: sql`excluded.type`, listId: sql`excluded.list_id` },
        });
    }
    // Whatever the previous list had beyond the new one's length.
    await tx
      .delete(threadgateAllowRules)
      .where(
        and(
          eq(threadgateAllowRules.threadgateId, row.id),
          gte(threadgateAllowRules.position, gate.allow.length),
        ),
      );

    return {
      id: row.id,
      postUri: row.postUri,
      postId: row.postId,
      allow: await loadAllowRules(row.id, tx),
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });
}

/**
 * The reply-control gate for `postId`, or `null`.
 *
 * `post_id` is INDEXED but not unique — the gate's identity is `post_uri`, which
 * embeds the id of whoever wrote the gate, so one post can carry more than one
 * row. Mongo's `findOne` returned an arbitrary one; this returns the oldest, so
 * the same request twice cannot answer differently.
 */
export async function loadThreadgateByPostId(postId: string): Promise<ThreadgateRecord | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(threadgates)
    .where(eq(threadgates.postId, postId))
    .orderBy(asc(threadgates.createdAt), asc(threadgates.id))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    postUri: row.postUri,
    postId: row.postId,
    allow: await loadAllowRules(row.id, db),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Delete one threadgate. Its rules are `ON DELETE CASCADE`. */
export async function deleteThreadgate(id: string): Promise<void> {
  await getDb().delete(threadgates).where(eq(threadgates.id, id));
}

/** Create or replace the quote-control gate for `postUri`. */
export async function upsertPostgate(
  gate: {
    postUri: string;
    postId: string;
    createdBy: string;
    disableQuotes: boolean;
    detachedQuoteUris: readonly string[];
  },
): Promise<PostgateRecord> {
  const values = {
    postUri: gate.postUri,
    postId: gate.postId,
    createdBy: gate.createdBy,
    disableQuotes: gate.disableQuotes,
    detachedQuoteUris: [...gate.detachedQuoteUris],
  };
  const [row] = await getDb()
    .insert(postgates)
    .values(values)
    .onConflictDoUpdate({
      target: postgates.postUri,
      set: {
        postId: values.postId,
        createdBy: values.createdBy,
        disableQuotes: values.disableQuotes,
        detachedQuoteUris: values.detachedQuoteUris,
        updatedAt: new Date(),
      },
    })
    .returning();
  return {
    id: row.id,
    postUri: row.postUri,
    postId: row.postId,
    disableQuotes: row.disableQuotes,
    detachedQuoteUris: row.detachedQuoteUris ?? [],
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The quote-control gate for `postId`, or `null`. Oldest first — see above. */
export async function loadPostgateByPostId(postId: string): Promise<PostgateRecord | null> {
  const [row] = await getDb()
    .select()
    .from(postgates)
    .where(eq(postgates.postId, postId))
    .orderBy(asc(postgates.createdAt), asc(postgates.id))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    postUri: row.postUri,
    postId: row.postId,
    disableQuotes: row.disableQuotes,
    detachedQuoteUris: row.detachedQuoteUris ?? [],
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Delete one postgate. */
export async function deletePostgate(id: string): Promise<void> {
  await getDb().delete(postgates).where(eq(postgates.id, id));
}
