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
 * - comma-separated ids → explicit subset (e.g. `penalizeSeen,socialProof`)
 *
 * PHASE 5 — the default subset activates the useful, conservative, bounded
 * Phase 2b signals for For You:
 *   - `penalizeSeen`            — soft-downrank already-seen posts.
 *   - `coldStartBoost`          — surface fresh posts / low-follower authors.
 *   - `socialProof`            — lift posts the viewer's network engaged (needs `ctx.mutualIds`).
 *   - `noveltyBoost`           — exploration lift for novel-topic posts.
 *   - `verifiedBoost`          — small lift for verified authors (uses pre-rank `verified`).
 *   - `localBoost` (Phase 4d)   — modest first-party lift.
 *   - `languageMismatchPenalty` (Phase 4c) — off-language DISCOVERY downrank.
 *   - `starterPackBoost`        — bounded lift for authors OTHER people curated into
 *                                 starter packs that newcomers actually used. Costs
 *                                 no extra query (the score rides the cached author
 *                                 summary) and never penalizes, so it is safe ON by
 *                                 default; `FOR_YOU_PHASE2B_SIGNALS` still disables it.
 * `mediaBoost` and `dwellTime` stay OPTIONAL (allowed via env, not default): each
 * is a strong surface-shaping nudge better reserved for deliberate tuning/A-B.
 */
const PHASE2B_DEFAULT_SIGNAL_IDS = [
  'penalizeSeen',
  'coldStartBoost',
  'socialProof',
  'noveltyBoost',
  'verifiedBoost',
  'localBoost',
  'languageMismatchPenalty',
  'starterPackBoost',
] as const;

const PHASE2B_ALLOWED_SIGNAL_IDS = new Set<string>([
  'coldStartBoost',
  'penalizeSeen',
  'verifiedBoost',
  'socialProof',
  'noveltyBoost',
  'localBoost',
  'languageMismatchPenalty',
  'starterPackBoost',
  // OPTIONAL signals — enable-able via `FOR_YOU_PHASE2B_SIGNALS` for A/B + tuning,
  // but deliberately NOT in the default set.
  'mediaBoost',
  'positivity',
  'conversational',
  'dwellTime',
  'reciprocityBoost',
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
 * The For You DISCOVERY GATE (Phase 4b/4B) — hard filters applied ONLY to
 * candidates from non-trusted (discovery) lanes. Reused primitives + the
 * objective-junk gates + a per-user quality floor:
 *   - `minLength`       — a crude text floor (`discoveryGate.minTextLength`).
 *   - `lowEffortGate`   — emoji/shortcode-only + trusted spam/quality breach.
 *   - `nativeEngagement`— native-engagement floor OR viewer-interest match.
 *   - `minQuality`      — trusted-quality floor; NEUTRAL by default (opt-in via
 *                         `feedTuning.forYou.minQuality`), so it changes nothing
 *                         unless a viewer sets a threshold in For You settings.
 * Each reads its thresholds from `MtnConfig.feed.discoveryGate`; the opaque
 * `forYouGate` marker param lets these modules layer the viewer's
 * `feedTuning.forYou` overrides ON TOP of the config defaults (Phase 4B) while the
 * definition stays STATIC — a custom feed reusing the same module never carries
 * the marker, so it never reads For You tuning.
 */
const DISCOVERY_GATE_MODULE_IDS = ['minLength', 'lowEffortGate', 'nativeEngagement', 'minQuality'] as const;
const DISCOVERY_GATE_ALLOWED_IDS = new Set<string>(DISCOVERY_GATE_MODULE_IDS);

/**
 * Build a single gate ModuleRef. Every gate ref carries the opaque
 * `forYouGate: true` marker so its filter module reads per-viewer
 * `feedTuning.forYou` overrides (see `gateTuning` in `engine/filters`);
 * `minLength` additionally injects its threshold from config.
 */
function discoveryGateModule(id: string): ModuleRef {
  if (id === 'minLength') {
    return enabled('minLength', { minLength: MtnConfig.feed.discoveryGate.minTextLength, forYouGate: true });
  }
  return enabled(id, { forYouGate: true });
}

/**
 * Resolve the For You discovery-gate filters from `FOR_YOU_DISCOVERY_GATE` (mirror
 * of {@link resolvePhase2bSignals}). The gate is fully bypassed when the config
 * master switch `discoveryGate.enabled` is off.
 *
 * Env values:
 * - unset / `default` / `on` / `true` → the full gate (all modules)
 * - `off` / `false` / `0`            → no gate (empty)
 * - comma-separated ids              → explicit subset (e.g. `lowEffortGate,nativeEngagement`)
 *
 * SHADOW mode (`discoveryGate.shadow`) is orthogonal: it controls whether the
 * engine ENFORCES the resolved gate or only measures it (see `FeedEngine.gatherPool`).
 */
export function resolveDiscoveryGate(): ModuleRef[] {
  if (MtnConfig.feed.discoveryGate.enabled !== true) {
    return [];
  }
  const raw = process.env.FOR_YOU_DISCOVERY_GATE?.trim();
  if (raw === 'off' || raw === 'false' || raw === '0') {
    return [];
  }
  if (!raw || raw === 'default' || raw === 'on' || raw === 'true') {
    return DISCOVERY_GATE_MODULE_IDS.map(discoveryGateModule);
  }
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((id) => id.length > 0 && DISCOVERY_GATE_ALLOWED_IDS.has(id))
    .map(discoveryGateModule);
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
  // Phase 4: the discovery gate applies ONLY to non-trusted lanes. `filters` stays
  // `[safety]` (always-on, every lane); the gate goes here so following/affinity/
  // lists are never gated. Ships in shadow mode (`discoveryGate.shadow`).
  discoveryFilters: resolveDiscoveryGate(),
  execution: {
    maxPool: MtnConfig.feed.candidateSources.maxPool,
    seenPosts: true,
    neverBlank: true,
    popularFallback: 'popular',
    replyContext: true,
    threadGrouping: true,
    hydrateMaxDepth: 0,
    // Phase 5: cap the discovery SHARE of a rendered page. `capDiscoveryShare`
    // DEFERS (never drops — same contract as `diversifyByAuthor`) discovery-origin
    // slices above `floor(maxDiscoveryShare · limit)` to the page tail, so trusted
    // (following/affinity/lists) content keeps a floor. On a thin follow graph the
    // cap is unmet and discovery backfills; `neverBlank` + popular fallback intact.
    maxDiscoveryShare: MtnConfig.feed.forYou.maxDiscoveryShare,
  },
};

/**
 * Whether the resolved For You signal set enables the `socialProof` opt-in signal.
 * The controller uses this to decide whether to populate `ctx.mutualIds` for a For
 * You request: `socialProof` widens its network-engager set to `following ∪
 * mutuals`, so mutuals are only worth resolving when the signal is active. Reads
 * the module-load-resolved {@link forYouDefinition} signals (which honor the
 * `FOR_YOU_PHASE2B_SIGNALS` env override), so a rollback that drops `socialProof`
 * also stops the extra mutuals query.
 */
export function forYouUsesSocialProof(): boolean {
  return forYouDefinition.signals.some((ref) => ref.enabled && ref.module === 'socialProof');
}

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
