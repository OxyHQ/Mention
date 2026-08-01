/**
 * For You + timeline source modules.
 *
 * These WRAP the pre-existing candidate-source queries (extracted per-lane from
 * `forYouCandidateSources.ts`) and the Following/List/Topic timeline queries.
 * `following` / `lists` / `topic` are shared between the ranked For You lanes and
 * their standalone chronological feeds; they branch on their params
 * (`timeline` / `listId` / `slug`). No new query logic is introduced here.
 */

import { PostVisibility } from '@mention/shared-types';
import { and, eq, inArray, or, type SQL } from 'drizzle-orm';
import { getDb } from '../../../../db/postgres';
import { accountListMembers, posts } from '../../../../db/schema';
import { assemblePostRecords } from '../../../../db/posts/postRepository';
import { followedAuthorsSql } from '../../../../utils/postAuthorship';
import { topicSlugSql } from '../../../../utils/postTopicMatch';
import { chronoCursorSql, chronoOrderBy } from '../../CursorBuilder';
import { logger } from '../../../../utils/logger';
import type { CandidatePost, FeedEngineContext, SourceModule } from '../types';
import {
  CandidateUserBehavior,
  GatherForYouCandidatesParams,
  gatherFollowingLane,
  gatherSubscribedListsLane,
  gatherAffinityLane,
  gatherTopicsLane,
  gatherLanguageLane,
  gatherRegionLane,
  gatherTrendingLane,
  gatherGlobalLane,
} from '../../feeds/forYouCandidateSources';

/**
 * Followed-authors + subscribed-list visibility match for the CHRONOLOGICAL
 * Following feed. Followed authors (and the viewer) may show PUBLIC or
 * FOLLOWERS_ONLY posts; subscribed-list-only authors show PUBLIC only (list
 * subscription is feed-inclusion, never a follow relationship). Extracted here
 * so the `following` source and the legacy `FollowingFeed` share one definition.
 */
export function buildFollowingVisibilitySql(
  currentUserId: string,
  followingIds: string[] = [],
  subscribedListMemberIds: string[] = [],
): SQL {
  const followAuthorizedIds = Array.from(new Set([currentUserId, ...followingIds]));
  const publicOnlyListIds = Array.from(
    new Set(subscribedListMemberIds.filter((id) => id !== currentUserId && !followAuthorizedIds.includes(id))),
  );

  const followed = and(
    followedAuthorsSql(followAuthorizedIds),
    inArray(posts.visibility, [PostVisibility.PUBLIC, PostVisibility.FOLLOWERS_ONLY]),
  ) as SQL;

  if (publicOnlyListIds.length === 0) return followed;

  return or(
    followed,
    and(
      followedAuthorsSql(publicOnlyListIds),
      eq(posts.visibility, PostVisibility.PUBLIC),
    ) as SQL,
  ) as SQL;
}

/** Translate the engine context into For You lane params (null when anonymous). */
function forYouParams(ctx: FeedEngineContext): GatherForYouCandidatesParams | null {
  if (!ctx.currentUserId) return null;
  return {
    viewerId: ctx.currentUserId,
    followingIds: ctx.followingIds ?? [],
    subscribedListMemberIds: ctx.subscribedListMemberIds,
    userBehavior: ctx.userBehavior as CandidateUserBehavior | undefined,
    viewerRegion: ctx.viewerRegion,
    seenPostIds: ctx.seenPostIds ?? [],
    oxyClient: ctx.privacyOxyClient,
  };
}

/** Run a chronological post scan with the shared keyset + order. */
async function fetchChrono(
  conditions: SQL[],
  cursor: string | undefined,
  cap: number,
): Promise<CandidatePost[]> {
  const keyset = await chronoCursorSql(cursor);
  const where = keyset ? [...conditions, keyset] : conditions;

  const db = getDb();
  const rows = await db
    .select()
    .from(posts)
    .where(and(...where))
    .orderBy(...chronoOrderBy())
    .limit(cap);
  return assemblePostRecords(rows, db);
}

/** CHRONOLOGICAL Following-feed query (public/followers-only + subscribed lists). */
async function gatherFollowingTimeline(ctx: FeedEngineContext, cap: number): Promise<CandidatePost[]> {
  const { currentUserId, followingIds, subscribedListMemberIds } = ctx;
  if (!currentUserId || (!followingIds?.length && !subscribedListMemberIds?.length)) return [];

  return fetchChrono(
    [
      buildFollowingVisibilitySql(currentUserId, followingIds, subscribedListMemberIds),
      eq(posts.status, 'published'),
    ],
    ctx.cursor,
    cap,
  );
}

/**
 * CHRONOLOGICAL List-feed query (posts from an AccountList's members).
 *
 * Members are a junction TABLE, not the embedded id array Mongo held, so this
 * reads `account_list_members` rather than the list row.
 */
async function gatherListTimeline(listId: string, ctx: FeedEngineContext, cap: number): Promise<CandidatePost[]> {
  let memberIds: string[] = [];
  try {
    const rows = await getDb()
      .select({ oxyUserId: accountListMembers.oxyUserId })
      .from(accountListMembers)
      .where(eq(accountListMembers.listId, listId))
      .orderBy(accountListMembers.position);
    memberIds = rows.map((row) => row.oxyUserId);
  } catch (error) {
    logger.warn('[lists source] Failed to load list', { listId, error });
    return [];
  }
  if (!memberIds.length) return [];

  return fetchChrono(
    [
      inArray(posts.oxyUserId, memberIds),
      eq(posts.visibility, 'public'),
      eq(posts.status, 'published'),
    ],
    ctx.cursor,
    cap,
  );
}

/**
 * CHRONOLOGICAL Topic-feed query. Matches the SAME post set TrendingService
 * counts for the slug: a post is on the topic through EITHER the registry-linked
 * `postClassification.topicRefs.name` OR the slug-only `postClassification.topics`
 * (see {@link buildTopicSlugMatch}). Matching only `topics` here was the "topic
 * trends but its page is empty" bug — a post classified with a canonical
 * `topicRefs` entry but no matching slug in `topics` was counted as trending yet
 * never returned by this feed. The topic `$or` is nested under `$and` so the
 * cursor `$or` that {@link ChronoCursor.applyToQuery} may add cannot clobber it.
 */
async function gatherTopicTimeline(slug: string, ctx: FeedEngineContext, cap: number): Promise<CandidatePost[]> {
  return fetchChrono(
    [topicSlugSql(slug), eq(posts.visibility, 'public'), eq(posts.status, 'published')],
    ctx.cursor,
    cap,
  );
}

/**
 * Run a For You lane for the viewer, returning `[]` when anonymous. The lane
 * results are lean Mongo docs typed as the shared engine {@link CandidatePost}.
 */
async function runForYouLane(
  ctx: FeedEngineContext,
  lane: (p: GatherForYouCandidatesParams) => Promise<CandidatePost[]>,
): Promise<CandidatePost[]> {
  const p = forYouParams(ctx);
  if (!p) return [];
  return lane(p);
}

/**
 * `following`: the viewer's followed authors. Ranked For You lane by default;
 * the chronological Following-feed query when `params.timeline === true`.
 */
export const followingSource: SourceModule = {
  id: 'following',
  kind: 'source',
  userComposable: false,
  // TRUSTED: the viewer's own follow graph is never subjected to the discovery gate.
  trusted: true,
  gather: async (ctx, params, cap) => {
    if (params.timeline === true) return gatherFollowingTimeline(ctx, cap);
    return runForYouLane(ctx, gatherFollowingLane);
  },
};

/**
 * `lists`: subscribed-list authors (ranked For You lane) OR a specific list's
 * members (chronological List feed) when `params.listId` is set.
 */
export const listsSource: SourceModule = {
  id: 'lists',
  kind: 'source',
  userComposable: false,
  // TRUSTED: subscribed-list authors are a viewer-chosen inclusion, never gated.
  trusted: true,
  gather: async (ctx, params, cap) => {
    if (typeof params.listId === 'string' && params.listId) {
      return gatherListTimeline(params.listId, ctx, cap);
    }
    return runForYouLane(ctx, gatherSubscribedListsLane);
  },
};

/**
 * `topic`: classified-topic match. Ranked For You lane (viewer's preferred
 * topics) by default; chronological Topic feed for a specific `params.slug`.
 */
export const topicSource: SourceModule = {
  id: 'topic',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, params, cap) => {
    if (typeof params.slug === 'string' && params.slug) {
      return gatherTopicTimeline(params.slug, ctx, cap);
    }
    return runForYouLane(ctx, gatherTopicsLane);
  },
};

/** `affinity`: For You ranked lane — posts from authors the viewer engages with. */
export const affinitySource: SourceModule = {
  id: 'affinity',
  kind: 'source',
  userComposable: false,
  // TRUSTED: affinity authors are learned from the viewer's own engagement, never gated.
  trusted: true,
  gather: async (ctx) => runForYouLane(ctx, gatherAffinityLane),
};

/** `language`: For You ranked lane — posts in the viewer's preferred languages. */
export const languageSource: SourceModule = {
  id: 'language',
  kind: 'source',
  userComposable: true,
  gather: async (ctx) => runForYouLane(ctx, gatherLanguageLane),
};

/** `region`: For You ranked lane — posts in the viewer's learned region. */
export const regionSource: SourceModule = {
  id: 'region',
  kind: 'source',
  userComposable: true,
  gather: async (ctx) => runForYouLane(ctx, gatherRegionLane),
};

/** `trending`: For You ranked lane — recent high-engagement posts. */
export const trendingSource: SourceModule = {
  id: 'trending',
  kind: 'source',
  userComposable: true,
  gather: async (ctx) => runForYouLane(ctx, gatherTrendingLane),
};

/** `globalDiscovery`: For You ranked lane — recent public SFW posts (serendipity). */
export const globalDiscoverySource: SourceModule = {
  id: 'globalDiscovery',
  kind: 'source',
  userComposable: true,
  gather: async (ctx) => runForYouLane(ctx, gatherGlobalLane),
};

export const forYouSourceModules: SourceModule[] = [
  followingSource,
  listsSource,
  topicSource,
  affinitySource,
  languageSource,
  regionSource,
  trendingSource,
  globalDiscoverySource,
];
