/**
 * Reading a stored custom feed back out of its five tables.
 *
 * Extracted from `routes/customFeeds.routes.ts`, which still owns the WIRE
 * format (`serializeFeed`) — this module owns only the reassembly the wire
 * format and the feed ENGINE both need. It exists because they are two
 * consumers of one non-trivial join: Mongo carried the sources, signals,
 * filters, members, source lists and topics INSIDE the document, and a second
 * hand-rolled gather would be a second place for `position` order to be lost.
 *
 * ## Why the engine needed it
 *
 * `mtn/feed/definitions/customFeedDefinition.ts` loaded feeds from the Mongo
 * `CustomFeed` model, which nothing writes any more — every write goes through
 * `routes/customFeeds.routes.ts` into `custom_feeds`. A feed created after that
 * move therefore did not resolve, and the failure was a feed the user built
 * rendering as "not found" rather than an error anyone could act on.
 */

import { asc, eq, inArray } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import {
  customFeedDefinitionModules,
  customFeedMembers,
  customFeedSourceLists,
  customFeedTopics,
  customFeeds,
} from '../schema/feeds';
import type { StoredFeedDefinition } from '../../models/CustomFeed';
import type { ModuleRef } from '../../mtn/feed/engine/types';
import type { CustomFeedSource } from '../../mtn/feed/definitions/customFeedDefinition';

// ---------------------------------------------------------------------------
// Reassembling a feed document out of its five tables
// ---------------------------------------------------------------------------

export type FeedRow = typeof customFeeds.$inferSelect;

/**
 * The child rows a feed needs before it can be serialized.
 *
 * Mongo carried all four of these INSIDE the document (`definition.sources` /
 * `.signals` / `.filters`, `memberOxyUserIds`, `sourceListIds`, `topicIds`), and
 * the API published every one of them. They are separate tables now, so every
 * read that serializes a feed has to gather them back — the wire format is the
 * contract, not the storage shape.
 */
export interface FeedRelations {
  /** `sources` / `signals` / `filters`, each already in `position` order. */
  sources: ModuleRef[];
  signals: ModuleRef[];
  filters: ModuleRef[];
  memberOxyUserIds: string[];
  sourceListIds: string[];
  topicIds: string[];
}

export function emptyRelations(): FeedRelations {
  return { sources: [], signals: [], filters: [], memberOxyUserIds: [], sourceListIds: [], topicIds: [] };
}

/** A module's `params` is `jsonb` and therefore `unknown`; only an object is one. */
function isParamsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Load the child rows for a page of feeds.
 *
 * Four queries rather than four-per-feed, and each is ordered so the arrays come
 * back the way the document held them. **Module order is EVALUATION order** —
 * the engine runs sources, then signals, then filters, in list order — so
 * `position` is not cosmetic and every read has to honour it.
 *
 * `custom_feed_source_lists` and `custom_feed_topics` carry no `position`
 * column, so their original array order is not recoverable; they are ordered by
 * `id` to be at least deterministic. Neither is order-sensitive (a source list
 * is a set union, a topic id is a set membership test).
 */
export async function loadFeedRelations(
  db: DatabaseOrTransaction,
  feedIds: string[],
): Promise<Map<string, FeedRelations>> {
  const byFeed = new Map<string, FeedRelations>(feedIds.map((id) => [id, emptyRelations()]));
  if (feedIds.length === 0) return byFeed;

  // `inArray`, never a hand-built `= any(${ids})`: a raw JS array interpolated
  // into `sql` binds as a ROW constructor and Postgres rejects it at runtime.
  const [modules, members, sourceLists, topics] = await Promise.all([
    db
      .select()
      .from(customFeedDefinitionModules)
      .where(inArray(customFeedDefinitionModules.feedId, feedIds))
      .orderBy(asc(customFeedDefinitionModules.position)),
    db
      .select({ feedId: customFeedMembers.feedId, oxyUserId: customFeedMembers.oxyUserId })
      .from(customFeedMembers)
      .where(inArray(customFeedMembers.feedId, feedIds))
      .orderBy(asc(customFeedMembers.position)),
    db
      .select({ feedId: customFeedSourceLists.feedId, listId: customFeedSourceLists.listId })
      .from(customFeedSourceLists)
      .where(inArray(customFeedSourceLists.feedId, feedIds))
      .orderBy(asc(customFeedSourceLists.id)),
    db
      .select({ feedId: customFeedTopics.feedId, topicId: customFeedTopics.topicId })
      .from(customFeedTopics)
      .where(inArray(customFeedTopics.feedId, feedIds))
      .orderBy(asc(customFeedTopics.id)),
  ]);

  for (const row of modules) {
    const relations = byFeed.get(row.feedId);
    if (!relations) continue;
    const ref: ModuleRef = {
      module: row.module,
      enabled: row.enabled,
      ...(isParamsObject(row.params) ? { params: row.params } : {}),
      ...(row.weight === null ? {} : { weight: row.weight }),
    };
    if (row.kind === 'source') relations.sources.push(ref);
    else if (row.kind === 'signal') relations.signals.push(ref);
    else relations.filters.push(ref);
  }
  for (const row of members) byFeed.get(row.feedId)?.memberOxyUserIds.push(row.oxyUserId);
  for (const row of sourceLists) byFeed.get(row.feedId)?.sourceListIds.push(row.listId);
  for (const row of topics) byFeed.get(row.feedId)?.topicIds.push(row.topicId);

  return byFeed;
}

/**
 * The composable definition, or `undefined` for a feed that predates Phase 3.
 *
 * `definition_mode IS NULL` is exactly Mongoose's absent `definition`
 * subdocument, and the request-time fallback in `customFeedDefinition.ts`
 * depends on telling the two apart — a feed given an empty definition instead of
 * no definition would render empty rather than falling back to its legacy
 * filters.
 */
export function definitionOf(row: FeedRow, relations: FeedRelations): StoredFeedDefinition | undefined {
  if (row.definitionMode === null) return undefined;
  return {
    mode: row.definitionMode,
    sources: relations.sources,
    signals: relations.signals,
    filters: relations.filters,
  };
}

/**
 * Replace a feed's module lists.
 *
 * DELETE-then-INSERT inside one transaction, which is what keeps
 * `custom_feed_definition_modules_feed_kind_position_key` from firing halfway
 * through: every old `(kind, position)` is released before any new one is
 * claimed, so a reorder that reuses the same positions cannot collide with
 * itself.
 *
 * Lives here rather than in the route because it now has two callers — the
 * route and `scripts/backfillCustomFeedDefinitions.ts` — and a second
 * hand-rolled copy is a second place for the delete-then-insert ordering, or
 * the `kind` → list mapping, to be got wrong.
 */
export async function replaceDefinitionModules(
  tx: DatabaseOrTransaction,
  feedId: string,
  definition: StoredFeedDefinition,
): Promise<void> {
  await tx
    .delete(customFeedDefinitionModules)
    .where(eq(customFeedDefinitionModules.feedId, feedId));

  const rows = (
    [
      ['source', definition.sources],
      ['signal', definition.signals],
      ['filter', definition.filters],
    ] as const
  ).flatMap(([kind, refs]) =>
    (refs ?? []).map((ref, position) => ({
      feedId,
      kind,
      position,
      module: ref.module,
      enabled: ref.enabled,
      params: ref.params ?? null,
      weight: ref.weight ?? null,
    })),
  );
  if (rows.length > 0) await tx.insert(customFeedDefinitionModules).values(rows);
}

/** Load one feed with its child rows, or `null`. */
export async function loadFeed(
  db: DatabaseOrTransaction,
  feedId: string,
): Promise<{ row: FeedRow; relations: FeedRelations } | null> {
  const [row] = await db.select().from(customFeeds).where(eq(customFeeds.id, feedId)).limit(1);
  if (!row) return null;
  const relations = await loadFeedRelations(db, [row.id]);
  return { row, relations: relations.get(row.id) ?? emptyRelations() };
}


/**
 * A stored feed in the shape {@link buildCustomFeedDefinition} consumes, or
 * `null` when no feed has that id.
 *
 * Carries `ownerOxyUserId` and `isPublic` as well, because both callers need
 * them: one to decide visibility, the other to answer a save request. Reading
 * them off the SAME row keeps that decision from being two queries that could
 * disagree.
 *
 * The LEGACY filter columns come along deliberately —
 * `legacyCustomFeedToDefinition` derives a runnable definition from them for any
 * feed that predates the composable `definition`, and dropping them would make
 * every such feed silently empty rather than absent.
 */
export async function loadCustomFeedSource(
  feedId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CustomFeedSource | null> {
  const loaded = await loadFeed(db, feedId);
  if (!loaded) return null;
  const { row, relations } = loaded;
  const definition = definitionOf(row, relations);
  return {
    _id: row.id,
    ownerOxyUserId: row.ownerOxyUserId,
    title: row.title,
    isPublic: row.isPublic,
    ...(definition === undefined ? {} : { definition }),
    memberOxyUserIds: relations.memberOxyUserIds,
    keywords: row.keywords ?? [],
    // `sourceListIds` and `topicIds` are deliberately NOT here: they are part of
    // the wire format but `legacyCustomFeedToDefinition` reads neither, so
    // carrying them would widen `CustomFeedSource` with fields no resolver
    // consults.
    includeReplies: row.includeReplies,
    includeBoosts: row.includeBoosts,
    includeMedia: row.includeMedia,
    ...(row.language === null ? {} : { language: row.language }),
  };
}
