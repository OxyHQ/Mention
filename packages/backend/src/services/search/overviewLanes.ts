/**
 * The lane implementations behind `GET /search/overview`.
 *
 * ## These are PREVIEW projections, deliberately not the tab's payload
 *
 * Each lane returns the handful of fields a search result CARD renders — id,
 * title, description, a count, an owner — and not the full document the
 * dedicated tab's endpoint returns. That is not a shortcut:
 *
 * - The overview shows five rows per lane. Serializing a full custom feed
 *   (definition, topic ids, source lists, ratings, cover image) to render a
 *   two-line card is work nobody reads.
 * - The frontend's card mappers (`toFeedCardData`, `toListCardData`,
 *   `toStarterPackCardData`) already read a loose, all-optional shape, because
 *   they had to tolerate three different backends. So the preview and the full
 *   payload both feed them without a second mapper.
 *
 * What is NOT re-implemented here is the text predicate: those come from
 * `utils/searchPredicates.ts`, shared with the per-lane routes, because the
 * predicate carries both an index coupling and a correctness recheck that must
 * not drift. Projections differ per surface; predicates must not.
 *
 * ## The connection is a required argument
 *
 * Each lane query takes `db` rather than calling `getDb()`, because the route
 * runs it inside `withStatementTimeout` and that budget is `SET LOCAL` on the
 * transaction it opens. A lane reaching for `getDb()` instead ran on another
 * pooled connection with no budget at all while the transaction sat idle
 * beside it — which is how the 1s statement budget never bounded anything and a
 * hashtag seq scan held production overviews for 5–10s (issue #1140).
 * Required, not defaulted, so that mistake cannot be made by omission.
 *
 * ## One profile resolution for every lane
 *
 * Lists, feeds and starter packs each render an owner. Resolved as ONE batch
 * across all three lanes rather than once per lane — which is a saving the
 * client-side fan-out could not make, because its lanes were separate HTTP
 * requests to separate handlers and each resolved its own.
 */

import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';

import { getDb, type DatabaseOrTransaction } from '../../db/postgres';
import { accountListMembers, accountLists, starterPackMembers, starterPacks } from '../../db/schema/lists';
import { customFeeds } from '../../db/schema/feeds';
import {
  accountListSearchPredicate,
  customFeedSearchPredicate,
  starterPackSearchPredicate,
} from '../../utils/searchPredicates';
import { resolveUserSummaries } from '../PostHydrationService';
import type { CachedUserSummary } from '../userSummaryCache';
import { logger } from '../../utils/logger';

/** The owner shape the search cards read. Matches the loose client type. */
export interface LaneOwner {
  id: string;
  username?: string;
  name?: { displayName?: string };
  avatar?: string;
}

export interface ListPreview {
  id: string;
  _id: string;
  title: string;
  description?: string;
  memberCount: number;
  owner?: LaneOwner;
}

export interface FeedPreview {
  id: string;
  _id: string;
  title: string;
  description?: string;
  subscriberCount: number;
  owner?: LaneOwner;
}

export interface StarterPackPreview {
  id: string;
  _id: string;
  name: string;
  description?: string;
  memberCount: number;
  useCount: number;
  creator?: LaneOwner;
}

/** A row from one of the three lanes, before its owner is attached. */
interface OwnedRow {
  ownerOxyUserId: string;
}

/**
 * Count members for a set of parents, keyed by parent id.
 *
 * A `GROUP BY` over the junction rather than loading the ids: the card shows a
 * NUMBER, and fetching every member id to call `.length` on it is the shape
 * that turns a five-row preview into thousands of rows for a large list.
 */
async function countMembers(
  table: typeof accountListMembers | typeof starterPackMembers,
  parentColumn: typeof accountListMembers.listId | typeof starterPackMembers.packId,
  parentIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (parentIds.length === 0) return counts;
  const rows = await getDb()
    .select({ parentId: parentColumn, count: sql<number>`count(*)::int` })
    .from(table)
    .where(inArray(parentColumn, parentIds))
    .groupBy(parentColumn);
  for (const row of rows) counts.set(row.parentId, row.count);
  return counts;
}

/**
 * Resolve owners for every row across every lane, in one batch.
 *
 * Best-effort, matching `resolveUserProfiles` in the feeds route: a failure
 * leaves the cards without an owner line rather than failing the lane, because
 * a search result missing its author byline is still a usable result.
 */
export async function resolveLaneOwners(rows: readonly OwnedRow[][]): Promise<Map<string, LaneOwner>> {
  const ids = Array.from(
    new Set(rows.flat().map((row) => row.ownerOxyUserId).filter((id) => typeof id === 'string' && id.length > 0)),
  );
  const owners = new Map<string, LaneOwner>();
  if (ids.length === 0) return owners;

  let summaries = new Map<string, CachedUserSummary>();
  try {
    summaries = await resolveUserSummaries(ids);
  } catch (error) {
    logger.warn('[SearchOverview] Failed to resolve lane owners', { count: ids.length, error });
    return owners;
  }

  for (const id of ids) {
    // The profile lives on `summary.user` (a `PostUser`), not on the summary —
    // `followerCount`, `languages` and `starterPackScore` sit alongside it and
    // are deliberately kept OFF the author DTO, so reading them here would ship
    // ranking-side data to a search card.
    const user = summaries.get(id)?.user;
    owners.set(id, {
      id,
      username: user?.username,
      name: user?.name?.displayName ? { displayName: user.name.displayName } : undefined,
      avatar: typeof user?.avatar === 'string' ? user.avatar : undefined,
    });
  }
  return owners;
}

/** One row over the limit, so `hasMore` is observed rather than counted. */
function page<T>(rows: T[], limit: number): { items: T[]; hasMore: boolean } {
  const hasMore = rows.length > limit;
  return { items: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

/**
 * Lists matching `term` the viewer may see: public ones, plus their own.
 *
 * The visibility scope is written here rather than shared, unlike the text
 * predicate — it is one `or` with no index coupling and no recheck, and it
 * genuinely differs per surface (the tab also serves `?mine=true` and
 * `?userId=`).
 */
export async function listLane(
  db: DatabaseOrTransaction,
  term: string,
  limit: number,
  viewerId: string | undefined,
): Promise<{ rows: (typeof accountLists.$inferSelect)[]; hasMore: boolean }> {
  const visible = viewerId
    ? or(eq(accountLists.isPublic, true), eq(accountLists.ownerOxyUserId, viewerId))
    : eq(accountLists.isPublic, true);

  const fetched = await db
    .select()
    .from(accountLists)
    .where(and(visible, accountListSearchPredicate(term)))
    .orderBy(desc(accountLists.updatedAt), desc(accountLists.id))
    .limit(limit + 1);

  const { items, hasMore } = page(fetched, limit);
  return { rows: items, hasMore };
}

/** Public feeds matching `term`. The overview is a discovery surface. */
export async function feedLane(
  db: DatabaseOrTransaction,
  term: string,
  limit: number,
): Promise<{ rows: (typeof customFeeds.$inferSelect)[]; hasMore: boolean }> {
  const fetched = await db
    .select()
    .from(customFeeds)
    .where(and(eq(customFeeds.isPublic, true), customFeedSearchPredicate(term)))
    .orderBy(desc(customFeeds.updatedAt), desc(customFeeds.id))
    .limit(limit + 1);

  const { items, hasMore } = page(fetched, limit);
  return { rows: items, hasMore };
}

/** Starter packs matching `term`, ranked by use as the discovery tab ranks them. */
export async function starterPackLane(
  db: DatabaseOrTransaction,
  term: string,
  limit: number,
): Promise<{ rows: (typeof starterPacks.$inferSelect)[]; hasMore: boolean }> {
  const fetched = await db
    .select()
    .from(starterPacks)
    .where(starterPackSearchPredicate(term))
    // `id` last, so the order is a strict TOTAL order and the cursor the tab
    // continues from cannot repeat or skip a row.
    .orderBy(desc(starterPacks.useCount), desc(starterPacks.createdAt), desc(starterPacks.id))
    .limit(limit + 1);

  const { items, hasMore } = page(fetched, limit);
  return { rows: items, hasMore };
}

/** Attach owners and member counts, producing the shapes the cards read. */
export function toListPreviews(
  rows: readonly (typeof accountLists.$inferSelect)[],
  owners: Map<string, LaneOwner>,
  memberCounts: Map<string, number>,
): ListPreview[] {
  return rows.map((row) => ({
    id: row.id,
    _id: row.id,
    title: row.title,
    ...(row.description === null ? {} : { description: row.description }),
    memberCount: memberCounts.get(row.id) ?? 0,
    owner: owners.get(row.ownerOxyUserId),
  }));
}

export function toFeedPreviews(
  rows: readonly (typeof customFeeds.$inferSelect)[],
  owners: Map<string, LaneOwner>,
): FeedPreview[] {
  return rows.map((row) => ({
    id: row.id,
    _id: row.id,
    title: row.title,
    ...(row.description === null ? {} : { description: row.description }),
    subscriberCount: row.subscriberCount,
    owner: owners.get(row.ownerOxyUserId),
  }));
}

export function toStarterPackPreviews(
  rows: readonly (typeof starterPacks.$inferSelect)[],
  owners: Map<string, LaneOwner>,
  memberCounts: Map<string, number>,
): StarterPackPreview[] {
  return rows.map((row) => ({
    id: row.id,
    _id: row.id,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    memberCount: memberCounts.get(row.id) ?? 0,
    useCount: row.useCount,
    creator: owners.get(row.ownerOxyUserId),
  }));
}

/** Member counts for a page of lists. */
export function countListMembers(listIds: string[]): Promise<Map<string, number>> {
  return countMembers(accountListMembers, accountListMembers.listId, listIds);
}

/** Member counts for a page of starter packs. */
export function countPackMembers(packIds: string[]): Promise<Map<string, number>> {
  return countMembers(starterPackMembers, starterPackMembers.packId, packIds);
}
