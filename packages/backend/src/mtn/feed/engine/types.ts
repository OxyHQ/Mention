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

import type { HydratedPost, SlicedFeedResponse } from '@mention/shared-types';
import type { FeedContext } from '../FeedAPI';

/**
 * A lean candidate post as returned by a source before hydration (a lean Post
 * doc). Sources may attach engine bookkeeping fields (`finalScore` for
 * pre-scored sources, `_feedCursor` for ordered sources); those are read only by
 * the engine and left opaque otherwise.
 */
export type CandidatePost = Record<string, unknown> & {
  _id: unknown;
  oxyUserId?: string;
  createdAt?: Date | string;
  /** Pre-scored sources (e.g. Explore's aggregation) attach the ranked score. */
  finalScore?: number;
  /** Ordered sources (Saved, Author-likes) attach the next-page cursor token. */
  _feedCursor?: string;
};

export type ModuleKind = 'source' | 'signal' | 'filter';

/**
 * The per-request execution context threaded through every module. Extends the
 * shared {@link FeedContext} with the engine-populated fields the modules read
 * (viewer mutuals, resolved seen-post ids, the raw cursor, and the page limit).
 */
export interface FeedEngineContext extends FeedContext {
  /** Viewer's mutual-follow author ids. Populated only for definitions that use the `mutuals` source. */
  mutualIds?: string[];
  /**
   * The viewer's seen post ids (resolved by the engine for `seenPosts`
   * definitions). Sources exclude these; the engine marks emitted posts seen.
   */
  seenPostIds?: string[];
  /** The raw request cursor, forwarded so cursor-aware sources can page. */
  cursor?: string;
  /** The resolved page limit, so ordered/pre-scored sources can size their fetch. */
  pageLimit?: number;
}

export interface SourceModule {
  id: string;
  kind: 'source';
  /**
   * Whether a user may enable this source in a custom feed. Viewer-relative
   * sources (following / mutuals / saved / authored) are `false`.
   */
  userComposable: boolean;
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
  /** Ranked feeds: pass the viewer's sensitive opt-in into `rankPosts`. Default `false`. */
  passSensitiveOptIn?: boolean;
  /** Produce a sliced response. When `false`, hydrate the candidates as flat items (Saved, likes). Default `true`. */
  slice?: boolean;
  /** Saved feed: stamp `viewerState.isSaved` on every hydrated item. Default `false`. */
  markSaved?: boolean;
  /**
   * Ranked feeds whose single source already computed + sorted `finalScore`
   * (Explore's aggregation): skip `rankPosts`, sort by the source score, and let
   * the source apply the cursor. Default `false`.
   */
  preScored?: boolean;
}

export interface FeedDefinition {
  id: string;
  title: string;
  mode: 'ranked' | 'chronological';
  sources: ModuleRef[];
  signals: ModuleRef[];
  filters: ModuleRef[];
  /** Internal engine execution profile (see {@link FeedExecution}). */
  execution?: FeedExecution;
}

export type FeedEngineResult = SlicedFeedResponse;
export type { HydratedPost };
