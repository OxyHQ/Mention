/**
 * For You + timeline source modules.
 *
 * These WRAP the pre-existing candidate-source queries (extracted per-lane from
 * `forYouCandidateSources.ts`) and the Following/List/Topic timeline queries.
 * `following` / `lists` / `topic` are shared between the ranked For You lanes and
 * their standalone chronological feeds; they branch on their params
 * (`timeline` / `listId` / `slug`). No new query logic is introduced here.
 */

import mongoose from 'mongoose';
import { PostVisibility } from '@mention/shared-types';
import { Post } from '../../../../models/Post';
import { buildFollowedAuthorsMatch } from '../../../../utils/postAuthorship';
import { FEED_FIELDS } from '../../FeedAPI';
import { ChronoCursor } from '../../CursorBuilder';
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
export function buildFollowingVisibilityMatch(
  currentUserId: string,
  followingIds: string[] = [],
  subscribedListMemberIds: string[] = [],
): Record<string, unknown> {
  const followAuthorizedIds = Array.from(new Set([currentUserId, ...followingIds]));
  const publicOnlyListIds = Array.from(
    new Set(subscribedListMemberIds.filter((id) => id !== currentUserId && !followAuthorizedIds.includes(id))),
  );

  if (publicOnlyListIds.length === 0) {
    return {
      ...buildFollowedAuthorsMatch(followAuthorizedIds),
      visibility: { $in: [PostVisibility.PUBLIC, PostVisibility.FOLLOWERS_ONLY] },
    };
  }

  return {
    $and: [
      {
        $or: [
          {
            ...buildFollowedAuthorsMatch(followAuthorizedIds),
            visibility: { $in: [PostVisibility.PUBLIC, PostVisibility.FOLLOWERS_ONLY] },
          },
          {
            ...buildFollowedAuthorsMatch(publicOnlyListIds),
            visibility: PostVisibility.PUBLIC,
          },
        ],
      },
    ],
  };
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
  };
}

/** CHRONOLOGICAL Following-feed query (public/followers-only + subscribed lists). */
async function gatherFollowingTimeline(ctx: FeedEngineContext, cap: number): Promise<CandidatePost[]> {
  const { currentUserId, followingIds, subscribedListMemberIds } = ctx;
  if (!currentUserId || (!followingIds?.length && !subscribedListMemberIds?.length)) return [];

  const match: Record<string, unknown> = {
    ...buildFollowingVisibilityMatch(currentUserId, followingIds, subscribedListMemberIds),
    status: 'published',
  };
  ChronoCursor.applyToQuery(match, ctx.cursor);

  return await Post.find(match)
    .select(FEED_FIELDS)
    .sort({ _id: -1 })
    .limit(cap)
    .maxTimeMS(5000)
    .lean<CandidatePost[]>();
}

/** CHRONOLOGICAL List-feed query (posts from an AccountList's members). */
async function gatherListTimeline(listId: string, ctx: FeedEngineContext, cap: number): Promise<CandidatePost[]> {
  let memberIds: string[] = [];
  try {
    const { AccountList } = await import('../../../../models/AccountList.js');
    if (!mongoose.Types.ObjectId.isValid(listId)) return [];
    const list = await AccountList.findById(listId).lean();
    memberIds = list?.memberOxyUserIds || [];
  } catch {
    logger.warn('[lists source] Failed to load list', { listId });
    return [];
  }
  if (!memberIds.length) return [];

  const match: Record<string, unknown> = {
    oxyUserId: { $in: memberIds },
    visibility: 'public',
    status: 'published',
  };
  ChronoCursor.applyToQuery(match, ctx.cursor);

  return await Post.find(match)
    .select(FEED_FIELDS)
    .sort({ _id: -1 })
    .limit(cap)
    .maxTimeMS(5000)
    .lean<CandidatePost[]>();
}

/** CHRONOLOGICAL Topic-feed query (posts whose classification topics contain the slug). */
async function gatherTopicTimeline(slug: string, ctx: FeedEngineContext, cap: number): Promise<CandidatePost[]> {
  const normalized = slug.toLowerCase();
  const match: Record<string, unknown> = {
    'postClassification.topics': normalized,
    visibility: 'public',
    status: 'published',
  };
  ChronoCursor.applyToQuery(match, ctx.cursor);

  return await Post.find(match)
    .select(FEED_FIELDS)
    .sort({ _id: -1 })
    .limit(cap)
    .maxTimeMS(5000)
    .lean<CandidatePost[]>();
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
