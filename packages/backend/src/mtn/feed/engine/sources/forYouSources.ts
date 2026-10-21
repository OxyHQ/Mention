import { eligibleActivitySubscriptionAuthors } from '../../../../services/activitySubscriptionInterest';
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
import {
  followedCommunitiesSql,
  notCollapsedCrosspostSql,
} from '../../../../utils/feedQueryBuilder';
import { ChronoCursor, chronoCursorSql, chronoOrderBy } from '../../CursorBuilder';
import { fetchWithRecencyFallback } from '../../../../utils/feedUtils';
import { logger } from '../../../../utils/logger';
import type { CandidatePost, FeedEngineContext, SourceModule } from '../types';
import {
  type CandidateUserBehavior,
  type GatherForYouCandidatesParams,
  gatherActivitySubscriptionsLane,
  gatherFollowingLane,
  gatherSubscribedListsLane,
  gatherAffinityLane,
  gatherTopicsLane,
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
  since?: Date,
  followedCommunityIds: string[] = [],
): SQL {
  const followAuthorizedIds = Array.from(new Set([currentUserId, ...followingIds]));
  const publicOnlyListIds = Array.from(
    new Set(
      subscribedListMemberIds.filter(
        (id) => id !== currentUserId && !followAuthorizedIds.includes(id),
      ),
    ),
  );

  const followed = and(
    followedAuthorsSql(followAuthorizedIds, since),
    inArray(posts.visibility, [PostVisibility.PUBLIC, PostVisibility.FOLLOWERS_ONLY]),
  ) as SQL;

  // The public-only branches: subscribed lists, and the posts written in a
  // followed community by people the viewer may not follow. Each is added only
  // when it can match, so a viewer who has neither reads the plain follow clause.
  const publicOnly: SQL[] = [];
  if (publicOnlyListIds.length > 0) {
    publicOnly.push(
      and(
        followedAuthorsSql(publicOnlyListIds, since),
        eq(posts.visibility, PostVisibility.PUBLIC),
      ) as SQL,
    );
  }
  if (followedCommunityIds.length > 0) {
    publicOnly.push(followedCommunitiesSql(followedCommunityIds, since));
  }
  return publicOnly.length === 0 ? followed : (or(followed, ...publicOnly) as SQL);
}

/** Translate the engine context into For You lane params (null when anonymous). */
function forYouParams(ctx: FeedEngineContext, cap?: number): GatherForYouCandidatesParams | null {
  if (!ctx.currentUserId) return null;
  return {
    viewerId: ctx.currentUserId,
    rankingAsOf: ctx.rankingAsOf,
    candidateLimit: ctx.paginationSession ? cap : undefined,
    followingIds: ctx.followingIds ?? [],
    activitySubscribedAuthorIds: eligibleActivitySubscriptionAuthors(
      ctx.activitySubscribedAuthorIds,
      ctx.userBehavior,
      [...(ctx.excludedAuthorIds ?? []), ...(ctx.viewerPrivacy?.blockedIds ?? [])],
    ),
    subscribedListMemberIds: ctx.subscribedListMemberIds,
    followedCommunityIds: ctx.followedCommunityIds,
    userBehavior: ctx.userBehavior as CandidateUserBehavior | undefined,
    viewerRegion: ctx.viewerRegion,
    viewerLanguages: ctx.viewerBaseLanguages,
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

/**
 * CHRONOLOGICAL Following-feed query (public/followers-only + subscribed lists).
 *
 * Read through progressively wider windows below the page's own boundary (the
 * cursor's time, or now), widening only when a window cannot fill the page. The
 * window is what lets `followedAuthorsSql` read a RANGE of the authorship index
 * rather than every post the followed accounts ever wrote — see its docblock for
 * the measurement. A reader whose follows post rarely pays one or two extra
 * narrow reads before the unbounded one; everyone else pays one.
 */
async function gatherFollowingTimeline(
  ctx: FeedEngineContext,
  cap: number,
  directOnly = false,
): Promise<CandidatePost[]> {
  const { currentUserId, followingIds, subscribedListMemberIds, followedCommunityIds } = ctx;
  const listMemberIds = directOnly ? [] : subscribedListMemberIds;
  const communityIds = directOnly ? [] : followedCommunityIds;
  if (!currentUserId || (!followingIds?.length && !listMemberIds?.length && !communityIds?.length))
    return [];

  const run = (since: Date | undefined) =>
    fetchChrono(
      [
        buildFollowingVisibilitySql(
          currentUserId,
          followingIds,
          listMemberIds,
          since,
          communityIds,
        ),
        eq(posts.status, 'published'),
        notCollapsedCrosspostSql(),
      ],
      ctx.cursor,
      cap,
    );

  // A legacy id-only cursor carries no time to measure a window from; it is
  // read unbounded, as it always was.
  const parsed = ChronoCursor.parse(ctx.cursor);
  if (parsed && parsed.ts === undefined) return run(undefined);
  return fetchWithRecencyFallback(cap, run, parsed?.ts ?? Date.now());
}

/**
 * CHRONOLOGICAL List-feed query (posts from an AccountList's members).
 *
 * Members are a junction TABLE, not an embedded id array, so this
 * reads `account_list_members` rather than the list row.
 */
async function gatherListTimeline(
  listId: string,
  ctx: FeedEngineContext,
  cap: number,
): Promise<CandidatePost[]> {
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
      notCollapsedCrosspostSql(),
    ],
    ctx.cursor,
    cap,
  );
}

/**
 * CHRONOLOGICAL Topic-feed query. Matches the SAME post set TrendingService
 * counts for the slug: a post is on the topic through EITHER the registry-linked
 * `post_classification_topic_refs.name` OR the slug-only
 * `posts.classification_topics` (see {@link topicSlugSql}). Matching only the
 * slug array here was the "topic trends but its page is empty" bug — a post
 * classified with a canonical ref but no matching slug in the array was counted
 * as trending yet never returned by this feed.
 */
async function gatherTopicTimeline(
  slug: string,
  ctx: FeedEngineContext,
  cap: number,
): Promise<CandidatePost[]> {
  return fetchChrono(
    [
      topicSlugSql(slug),
      eq(posts.visibility, 'public'),
      eq(posts.status, 'published'),
      notCollapsedCrosspostSql(),
    ],
    ctx.cursor,
    cap,
  );
}

/**
 * Run a For You lane for the viewer, returning `[]` when anonymous. The lane
 * results are typed as the shared engine {@link CandidatePost}.
 */
async function runForYouLane(
  ctx: FeedEngineContext,
  lane: (p: GatherForYouCandidatesParams) => Promise<CandidatePost[]>,
  cap?: number,
): Promise<CandidatePost[]> {
  const p = forYouParams(ctx, cap);
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
    if (params.timeline === true) {
      return gatherFollowingTimeline(ctx, cap, params.directOnly === true);
    }
    return runForYouLane(ctx, gatherFollowingLane, cap);
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
    return runForYouLane(ctx, gatherSubscribedListsLane, cap);
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
    return runForYouLane(ctx, gatherTopicsLane, cap);
  },
};

/** `affinity`: For You ranked lane — posts from authors the viewer engages with. */
export const affinitySource: SourceModule = {
  id: 'affinity',
  kind: 'source',
  userComposable: false,
  // TRUSTED to the discovery GATE — the viewer's own engagement vouches for these
  // authors' quality. NOT trusted for LANGUAGE: the lane excludes everyone the
  // viewer follows, so it is people they never chose, and `gatherAffinityLane`
  // filters it. See `feedLanguage.ts`.
  trusted: true,
  gather: async (ctx, _params, cap) => runForYouLane(ctx, gatherAffinityLane, cap),
};

/** `region`: For You ranked lane — posts in the viewer's learned region. */
export const regionSource: SourceModule = {
  id: 'region',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, _params, cap) => runForYouLane(ctx, gatherRegionLane, cap),
};

/** `trending`: For You ranked lane — recent high-engagement posts. */
export const trendingSource: SourceModule = {
  id: 'trending',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, _params, cap) => runForYouLane(ctx, gatherTrendingLane, cap),
};

/** `globalDiscovery`: For You ranked lane — recent public SFW posts (serendipity). */
export const globalDiscoverySource: SourceModule = {
  id: 'globalDiscovery',
  kind: 'source',
  userComposable: true,
  gather: async (ctx, _params, cap) => runForYouLane(ctx, gatherGlobalLane, cap),
};

/** Bell subscribers explicitly chose these authors; access remains public-only. */
export const activitySubscriptionsSource: SourceModule = {
  id: 'activitySubscriptions',
  kind: 'source',
  userComposable: false,
  trusted: true,
  gather: async (ctx, _params, cap) => runForYouLane(ctx, gatherActivitySubscriptionsLane, cap),
};

export const forYouSourceModules: SourceModule[] = [
  activitySubscriptionsSource,
  followingSource,
  listsSource,
  topicSource,
  affinitySource,
  regionSource,
  trendingSource,
  globalDiscoverySource,
];
