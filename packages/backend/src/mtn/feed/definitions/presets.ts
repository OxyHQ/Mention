/**
 * Built-in feed definitions.
 *
 * Each preset (and parameterized template) expresses a pre-existing feed as a
 * {@link FeedDefinition} over the wrapped source/signal/filter modules. The
 * `execution` profile carries the per-feed pipeline knobs the bespoke `FeedAPI`
 * classes hard-coded, so the engine reproduces their behavior exactly.
 */

import { MtnConfig } from '@mention/shared-types';
import type { AuthorFeedFilter } from '@mention/shared-types';
import type { FeedDefinition, ModuleRef } from '../engine/types';

function enabled(module: string, params?: Record<string, unknown>): ModuleRef {
  return params ? { module, enabled: true, params } : { module, enabled: true };
}

/** The full ranking-signal catalog (declarative; `rankPosts` composes them all). */
const ALL_RANKING_SIGNALS: ModuleRef[] = [
  'engagement', 'recency', 'authorRelationship', 'authorAuthority',
  'personalization', 'quality', 'trendingVelocity', 'timeOfDay', 'diversity',
].map((id) => enabled(id));

/**
 * Phase 2b opt-in signals enabled on For You / Videos when the env flag is on.
 * Roll back instantly by setting `FOR_YOU_PHASE2B_SIGNALS=off` (no preset redeploy).
 *
 * Env values:
 * - unset / `default` / `on` → the conservative default subset below
 * - `off` / `false` / `0` → no Phase 2b signals (legacy ranking)
 * - comma-separated ids → explicit subset (e.g. `penalizeSeen,dwellTime`)
 */
const PHASE2B_DEFAULT_SIGNAL_IDS = [
  'penalizeSeen',
  'dwellTime',
  'mediaBoost',
  'coldStartBoost',
] as const;

const PHASE2B_ALLOWED_SIGNAL_IDS = new Set<string>([
  'mediaBoost',
  'positivity',
  'conversational',
  'coldStartBoost',
  'penalizeSeen',
  'verifiedBoost',
  'dwellTime',
  'socialProof',
  'reciprocityBoost',
  'noveltyBoost',
]);

function parsePhase2bSignalIds(): string[] {
  const raw = process.env.FOR_YOU_PHASE2B_SIGNALS?.trim();
  if (raw === 'off' || raw === 'false' || raw === '0') {
    return [];
  }
  if (!raw || raw === 'default' || raw === 'on' || raw === 'true') {
    return [...PHASE2B_DEFAULT_SIGNAL_IDS];
  }
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((id) => id.length > 0 && PHASE2B_ALLOWED_SIGNAL_IDS.has(id));
}

/** Phase 2b opt-in signals resolved from `FOR_YOU_PHASE2B_SIGNALS`. */
export function resolvePhase2bSignals(): ModuleRef[] {
  return parsePhase2bSignalIds().map((id) => enabled(id));
}

/** Preset ranking signals = always-on catalog + env-gated Phase 2b subset. */
function buildPresetRankingSignals(): ModuleRef[] {
  return [...ALL_RANKING_SIGNALS, ...resolvePhase2bSignals()];
}

/**
 * For You — ranked, multi-source. Sources are listed in the exact merge order of
 * `gatherForYouCandidates` (following, subscribed lists, affinity, topics,
 * language, region, trending, global) so the engine merge reproduces it. The
 * `safety` filter provides the merged-pool SFW guard; the discovery lanes apply
 * their own query-level safety internally.
 */
export const forYouDefinition: FeedDefinition = {
  id: 'for_you',
  title: 'For You',
  mode: 'ranked',
  sources: [
    enabled('following'),
    enabled('lists'),
    enabled('affinity'),
    enabled('topic'),
    enabled('language'),
    enabled('region'),
    enabled('trending'),
    enabled('globalDiscovery'),
  ],
  signals: buildPresetRankingSignals(),
  filters: [enabled('safety')],
  execution: {
    maxPool: MtnConfig.feed.candidateSources.maxPool,
    seenPosts: true,
    neverBlank: true,
    popularFallback: 'popular',
    replyContext: true,
    threadGrouping: true,
    hydrateMaxDepth: 0,
  },
};

/** Following — chronological timeline of followed authors + subscribed lists. */
export const followingDefinition: FeedDefinition = {
  id: 'following',
  title: 'Following',
  mode: 'chronological',
  sources: [enabled('following', { timeline: true })],
  signals: [],
  filters: [enabled('safety')],
  execution: {
    overfetchMultiplier: MtnConfig.feed.sliceOverfetchMultiplier,
    replyContext: true,
    threadGrouping: true,
    hydrateMaxDepth: 0,
  },
};

/** Discover (Explore) — pre-scored engagement×recency×relevance discovery aggregation. */
export const exploreDefinition: FeedDefinition = {
  id: 'explore',
  title: 'Discover',
  mode: 'ranked',
  sources: [enabled('explore')],
  signals: [enabled('engagement'), enabled('recency')],
  filters: [enabled('safety')],
  execution: {
    preScored: true,
    threadGrouping: true,
    replyContext: false,
    hydrateMaxDepth: 0,
  },
};

/** Videos — ranked reels stream of video posts. */
export const videosDefinition: FeedDefinition = {
  id: 'videos',
  title: 'Videos',
  mode: 'ranked',
  sources: [enabled('videos')],
  signals: buildPresetRankingSignals(),
  filters: [enabled('safety')],
  execution: {
    seenPosts: true,
    popularFallback: 'popularVideos',
    threadGrouping: true,
    replyContext: false,
    hydrateMaxDepth: 0,
  },
};

/** Media — ranked stream of media posts. */
export const mediaDefinition: FeedDefinition = {
  id: 'media',
  title: 'Media',
  mode: 'ranked',
  sources: [enabled('media')],
  signals: ALL_RANKING_SIGNALS,
  filters: [enabled('safety')],
  execution: {
    seenPosts: true,
    popularFallback: 'popularMedia',
    threadGrouping: true,
    replyContext: false,
    hydrateMaxDepth: 0,
  },
};

/**
 * Trending — ranked engagement×recency over the engagement-sorted popular
 * source. Reuses the Phase 1 `popular` source (excludes boosts); `safety`
 * guards the merged pool.
 */
export const trendingDefinition: FeedDefinition = {
  id: 'trending',
  title: 'Trending',
  mode: 'ranked',
  sources: [enabled('popular')],
  signals: [enabled('engagement'), enabled('recency')],
  filters: [enabled('safety')],
  execution: {
    threadGrouping: true,
    replyContext: false,
    hydrateMaxDepth: 0,
  },
};

/**
 * Mutuals — chronological timeline of the viewer's mutual-follow authors.
 * Requires `ctx.mutualIds` (populated by the controller). Reply context + boost
 * hydration (`maxDepth:1`) so mutual replies/reposts render in full.
 */
export const mutualsDefinition: FeedDefinition = {
  id: 'mutuals',
  title: 'Mutuals',
  mode: 'chronological',
  sources: [enabled('mutuals')],
  signals: [],
  filters: [enabled('safety')],
  execution: {
    threadGrouping: true,
    replyContext: true,
    hydrateMaxDepth: 1,
  },
};

/**
 * Popular with Friends — ranked feed of posts the viewer's follows engaged with
 * (the `friendsEngaged` source pre-orders by friend-engagement count; the engine
 * re-ranks with engagement×recency, so `preScored:false`). `maxDepth:1` embeds
 * quoted originals; `safety` guards the pool.
 */
export const friendsPopularDefinition: FeedDefinition = {
  id: 'friends_popular',
  title: 'Popular with Friends',
  mode: 'ranked',
  sources: [enabled('friendsEngaged')],
  signals: [enabled('engagement'), enabled('recency')],
  filters: [enabled('safety')],
  execution: {
    preScored: false,
    hydrateMaxDepth: 1,
    threadGrouping: true,
    replyContext: false,
  },
};

/**
 * Friends of Friends — chronological timeline of posts by accounts the viewer's
 * follows follow (but the viewer does not). Requires `ctx.fofIds` (populated by
 * the controller via the Oxy follows-of-follows endpoint). Reply context + boost
 * hydration (`maxDepth:1`) so FoF replies/reposts render in full.
 */
export const friendsOfFriendsDefinition: FeedDefinition = {
  id: 'friends_of_friends',
  title: 'Friends of Friends',
  mode: 'chronological',
  sources: [enabled('friendsOfFriends')],
  signals: [],
  filters: [enabled('safety')],
  execution: {
    threadGrouping: true,
    replyContext: true,
    hydrateMaxDepth: 1,
  },
};

/** Saved — the viewer's bookmarks, in bookmark order (ordered, items-only). */
export const savedDefinition: FeedDefinition = {
  id: 'saved',
  title: 'Saved',
  mode: 'chronological',
  sources: [enabled('saved')],
  signals: [],
  filters: [enabled('safety')],
  execution: {
    ordered: true,
    markSaved: true,
    hydrateMaxDepth: 0,
  },
};

/** Author feed — a single author's posts/replies/media (chronological) or likes (ordered). */
export function authorDefinition(authorId: string, filter: AuthorFeedFilter): FeedDefinition {
  const isLikes = filter === 'likes';
  const filters: ModuleRef[] = filter === 'media' ? [enabled('mediaOnly')] : [];
  return {
    id: `author|${authorId}${filter === 'posts' ? '' : `|${filter}`}`,
    title: 'Author',
    mode: 'chronological',
    sources: [enabled('authored', { authorId, filter })],
    signals: [],
    filters,
    execution: isLikes
      ? { ordered: true, hydrateMaxDepth: 1 }
      : { threadGrouping: true, replyContext: false, hydrateMaxDepth: 1 },
  };
}

/** Hashtag feed — posts carrying a hashtag (chronological). */
export function hashtagDefinition(tag: string): FeedDefinition {
  const normalized = tag.toLowerCase();
  return {
    id: `hashtag|${normalized}`,
    title: `#${normalized}`,
    mode: 'chronological',
    sources: [enabled('keywords', { hashtags: [normalized] })],
    signals: [],
    filters: [enabled('safety')],
    execution: { threadGrouping: true, replyContext: false, hydrateMaxDepth: 0 },
  };
}

/** Topic feed — posts classified under a topic slug (chronological). */
export function topicDefinition(slug: string): FeedDefinition {
  return {
    id: `topic|${slug}`,
    title: slug,
    mode: 'chronological',
    sources: [enabled('topic', { slug })],
    signals: [],
    filters: [enabled('safety')],
    execution: { threadGrouping: true, replyContext: false, hydrateMaxDepth: 0 },
  };
}

/** List feed — posts from an AccountList's members (chronological). */
export function listDefinition(listId: string): FeedDefinition {
  return {
    id: `list|${listId}`,
    title: 'List',
    mode: 'chronological',
    sources: [enabled('lists', { listId })],
    signals: [],
    filters: [enabled('safety')],
    execution: { threadGrouping: true, replyContext: true, hydrateMaxDepth: 0 },
  };
}
