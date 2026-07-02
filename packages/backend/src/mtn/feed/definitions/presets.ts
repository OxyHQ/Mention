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
  signals: ALL_RANKING_SIGNALS,
  filters: [enabled('safety')],
  execution: {
    maxPool: MtnConfig.feed.candidateSources.maxPool,
    seenPosts: true,
    neverBlank: true,
    popularFallback: 'popular',
    passSensitiveOptIn: true,
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
  filters: [],
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
  filters: [],
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
  signals: ALL_RANKING_SIGNALS,
  filters: [],
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
  filters: [],
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
 * guards the merged pool and `passSensitiveOptIn` honors the viewer's opt-in.
 */
export const trendingDefinition: FeedDefinition = {
  id: 'trending',
  title: 'Trending',
  mode: 'ranked',
  sources: [enabled('popular')],
  signals: [enabled('engagement'), enabled('recency')],
  filters: [enabled('safety')],
  execution: {
    passSensitiveOptIn: true,
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
  filters: [],
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

/** Saved — the viewer's bookmarks, in bookmark order (ordered, items-only). */
export const savedDefinition: FeedDefinition = {
  id: 'saved',
  title: 'Saved',
  mode: 'chronological',
  sources: [enabled('saved')],
  signals: [],
  filters: [],
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
    filters: [],
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
    filters: [],
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
    filters: [],
    execution: { threadGrouping: true, replyContext: true, hydrateMaxDepth: 0 },
  };
}
