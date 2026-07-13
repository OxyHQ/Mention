/**
 * Feed Engine — module + definition types.
 *
 * The composable feed engine expresses every feed as a {@link FeedDefinition}: a
 * list of toggleable, parameterized {@link FeedModule}s (sources, signals,
 * filters) executed by a single generic engine. This replaces the bespoke
 * per-feed `FeedAPI` classes; each module WRAPS the pre-existing candidate-source
 * / ranking / tuner code (it does NOT reimplement it), so behavior — especially
 * For You ranking — is preserved.
 */

import type { HydratedPost, PostClassification, SlicedFeedResponse } from '@mention/shared-types';
import type { FeedContext } from '../FeedAPI';
import type { FeedSafetyPostShape } from '../feedSafety';

/**
 * A lean candidate post as returned by a source before hydration (a lean Post
 * doc). Sources may attach engine bookkeeping fields (`finalScore` for
 * pre-scored sources, `_feedCursor` for ordered sources); those are read only by
 * the engine and left opaque otherwise.
 *
 * Extends {@link FeedSafetyPostShape} so safety filters can call
 * `isSensitivePost(post)` without casting.
 */
export type CandidatePost = Record<string, unknown> & Omit<FeedSafetyPostShape, 'postClassification'> & {
  _id: unknown;
  oxyUserId?: string;
  createdAt?: Date | string;
  /** Pre-scored sources (e.g. Explore's aggregation) attach the ranked score. */
  finalScore?: number;
  /** Ordered sources (Saved, Author-likes) attach the next-page cursor token. */
  _feedCursor?: string;
  /**
   * DISCOVERY marker (Phase 4a). Stamped `true` by the engine on candidates that
   * came from a NON-trusted (discovery) source and passed the definition's
   * `discoveryFilters`. Read by the discovery-gate lane-scoping and the
   * `languageMismatchPenalty` ranking signal. Opaque engine bookkeeping — like
   * `finalScore` / `_feedCursor` it lives on the lean candidate ONLY and MUST NOT
   * leak into the hydrated {@link HydratedPost} (hydration builds a fresh DTO).
   */
  _discovery?: boolean;
  /** Classification fields used by sources, ranking, and safety filters. */
  postClassification?: Partial<PostClassification> & {
    /** Legacy extracted topics — used by related sources when topicRefs absent. */
    topics?: string[];
  };
};

export type ModuleKind = 'source' | 'signal' | 'filter';

/**
 * DISCOVERY-GATE A/B bucket (Phase 7). A viewer is deterministically assigned to
 * exactly one bucket by hashing their `oxyUserId` when the experiment env flag is
 * on. `gate-on` viewers get the For You discovery gate ENFORCED; `gate-off`
 * viewers get it MEASURED-ONLY (rejections counted, nothing dropped), so the two
 * cohorts' skip-rate / report-rate / engagement-per-impression can be compared
 * offline (the bucket is recomputable from the id). See `discoveryGateExperiment`.
 */
export type DiscoveryGateBucket = 'gate-on' | 'gate-off';

/**
 * The per-request execution context threaded through every module. Extends the
 * shared {@link FeedContext} with the engine-populated fields the modules read
 * (viewer mutuals, resolved seen-post ids, the raw cursor, and the page limit).
 */
export interface FeedEngineContext extends FeedContext {
  /** Viewer's mutual-follow author ids. Populated only for definitions that use the `mutuals` source. */
  mutualIds?: string[];
  /**
   * Viewer's friends-of-friends author ids (accounts the viewer's follows follow,
   * excluding the viewer's own follows + self). Populated by the controller ONLY
   * for the `friends_of_friends` descriptor, via the Oxy follows-of-follows
   * endpoint (guarded optional call), so no other feed pays for it.
   */
  fofIds?: string[];
  /**
   * The viewer's seen post ids (resolved by the engine for `seenPosts`
   * definitions). Sources exclude these; the engine marks emitted posts seen.
   */
  seenPostIds?: string[];
  /** The raw request cursor, forwarded so cursor-aware sources can page. */
  cursor?: string;
  /** The resolved page limit, so ordered/pre-scored sources can size their fetch. */
  pageLimit?: number;
  /**
   * Optional videos-feed filters parsed from query params (`orientation`, `minDuration`).
   * Applied by {@link FeedQueryBuilder.buildVideosQuery} — reads persisted media fields only.
   */
  videoFilters?: {
    orientation?: 'portrait' | 'landscape' | 'square' | 'all';
    minDurationSec?: number;
  };
  /**
   * DISCOVERY-GATE A/B bucket for this viewer (Phase 7). Resolved by the feed
   * controller ONLY for the For You descriptor when the experiment is enabled
   * (`FOR_YOU_DISCOVERY_GATE_AB`); otherwise absent. `gate-off` forces the gate
   * into measure-only mode for this viewer (rejections counted, never dropped)
   * exactly like the global shadow config, while `gate-on` enforces it — letting
   * the two cohorts be compared without a new flag channel. Absent ⇒ enforcement
   * follows the global `MtnConfig.feed.discoveryGate.shadow` config.
   */
  discoveryGateBucket?: DiscoveryGateBucket;
}

export interface SourceModule {
  id: string;
  kind: 'source';
  /**
   * Whether a user may enable this source in a custom feed. Viewer-relative
   * sources (following / mutuals / saved / authored) are `false`.
   */
  userComposable: boolean;
  /**
   * TRUSTED-lane marker (Phase 4a). A trusted source draws from the viewer's OWN
   * chosen graph (following / subscribed lists / affinity), so its candidates are
   * NEVER subjected to the discovery gate (`FeedDefinition.discoveryFilters`) nor
   * marked `_discovery`. Absent/`false` = a DISCOVERY source (topics / language /
   * region / trending / global), whose candidates ARE gated. Only meaningful for
   * ranked multi-source definitions that declare `discoveryFilters` (For You).
   */
  trusted?: boolean;
  gather(ctx: FeedEngineContext, params: Record<string, unknown>, cap: number): Promise<CandidatePost[]>;
}

export interface SignalModule {
  id: string;
  kind: 'signal';
  /**
   * The `FeedRankingService.rankPosts` weight key this signal maps onto. In
   * Phase 1 signals are represented as weight keys the engine forwards to
   * ranking (enable/disable = include/omit the weight); no new scoring code.
   */
  weightKey?: string;
}

export interface FilterModule {
  id: string;
  kind: 'filter';
  /**
   * Whether a user may enable this filter in a custom feed (surfaced in the
   * Phase 3 builder). Internal pipeline filters (safety / language / mute-block)
   * leave this unset. Undefined is treated as "not user-composable".
   */
  userComposable?: boolean;
  /** Optional Mongo clause merged into source queries via the shared base match. */
  clause?(ctx: FeedEngineContext, params: Record<string, unknown>): Record<string, unknown> | undefined;
  /** Optional in-memory predicate applied to the merged candidate pool. */
  keep?(post: CandidatePost, ctx: FeedEngineContext, params: Record<string, unknown>): boolean;
}

export type FeedModule = SourceModule | SignalModule | FilterModule;

export interface ModuleRef {
  module: string;
  enabled: boolean;
  params?: Record<string, unknown>;
  weight?: number;
}

/**
 * Internal engine execution profile. NOT part of the user-facing custom-feed
 * builder surface — it encodes the per-feed pipeline behaviors the bespoke
 * `FeedAPI` classes hard-coded (reply-context injection, hydration depth,
 * seen-post de-prioritization, never-blank fallback, ordered/no-slice item
 * feeds, pre-scored sources). Every field is optional and defaults to the safe /
 * common value.
 */
export interface FeedExecution {
  /** Enable self-thread grouping during slicing. Default `true`. */
  threadGrouping?: boolean;
  /** Inject reply-context parent slices. Default `false`. */
  replyContext?: boolean;
  /** Hydration depth; `1` embeds boosted/quoted originals (required for boosts). Default `0`. */
  hydrateMaxDepth?: 0 | 1;
  /**
   * Chronological fetch size multiplier: fetch `ceil(limit * multiplier)` posts
   * (plus one overfetch). Default `1` (i.e. `limit`). Following uses `1.5`.
   */
  overfetchMultiplier?: number;
  /**
   * Ranked feeds only: resolve + exclude the viewer's seen post ids and mark
   * emitted posts seen (For You / Videos / Media). Default `false`.
   */
  seenPosts?: boolean;
  /** Ranked personalized feeds: fall back to popular when the pool empties. Default `false`. */
  neverBlank?: boolean;
  /**
   * Source id serving the engagement-sorted popular fallback for the anonymous +
   * never-blank paths (For You / Videos / Media). When unset, ranked feeds have
   * no popular fallback (Explore serves anonymous via its own neutral-relevance
   * source).
   */
  popularFallback?: string;
  /**
   * Hard ceiling on the merged (deduped) candidate pool, applied during the
   * merge (For You uses `MtnConfig.feed.candidateSources.maxPool`). Unset =
   * single-source feeds rely on the source's own fetch limit (no engine cap).
   */
  maxPool?: number;
  /**
   * "Ordered" feeds (Saved, Author-likes): the source returns the page's
   * candidates already in order (stamping `_feedCursor` on the last one when more
   * pages exist). The engine skips ranking + slicing and hydrates flat items.
   * Default `false`.
   */
  ordered?: boolean;
  /** Saved feed: stamp `viewerState.isSaved` on every hydrated item. Default `false`. */
  markSaved?: boolean;
  /**
   * Ranked feeds whose single source already computed + sorted `finalScore`
   * (Explore's aggregation): skip `rankPosts`, sort by the source score, and let
   * the source apply the cursor. Default `false`.
   */
  preScored?: boolean;
  /**
   * DISCOVERY-SHARE CAP (Phase 5) — the maximum SHARE (0..1) of a rendered ranked
   * page that may come from DISCOVERY lanes (slices whose anchor post carries the
   * opaque `_discovery` marker). After author diversification and BEFORE page
   * truncation, `capDiscoveryShare` DEFERS — never drops (same contract as
   * `diversifyByAuthor`) — discovery slices beyond `floor(maxDiscoveryShare ·
   * limit)` to the page tail, guaranteeing a floor for trusted (following /
   * affinity / lists) content. Unset (every feed except For You) = no cap. On a
   * thin follow graph the cap is simply unmet and discovery backfills the page.
   */
  maxDiscoveryShare?: number;
}

/** The two execution modes a feed definition can run in. */
export type FeedDefinitionMode = 'ranked' | 'chronological';

export interface FeedDefinition {
  id: string;
  title: string;
  mode: FeedDefinitionMode;
  sources: ModuleRef[];
  signals: ModuleRef[];
  filters: ModuleRef[];
  /**
   * DISCOVERY GATE (Phase 4a) — filters applied ONLY to candidates from
   * NON-trusted (discovery) sources, on top of the always-applied {@link filters}.
   * A candidate that also appears in a TRUSTED lane is inserted as the trusted
   * copy first (source order + `_id` dedup), so followed/affinity authors are
   * never gated. In SHADOW mode (`MtnConfig.feed.discoveryGate.shadow`) the gate
   * is EVALUATED and counted but nothing is dropped. Only For You declares this;
   * every other feed leaves it unset (unaffected).
   */
  discoveryFilters?: ModuleRef[];
  /** Internal engine execution profile (see {@link FeedExecution}). */
  execution?: FeedExecution;
}

export type FeedEngineResult = SlicedFeedResponse;
export type { HydratedPost };
