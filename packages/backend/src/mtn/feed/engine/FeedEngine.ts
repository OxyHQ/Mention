/**
 * Feed Engine
 *
 * The generic source → filter → rank/sort → slice → paginate pipeline that runs
 * a {@link FeedDefinition}. It GENERALIZES the bespoke `FeedAPI` classes:
 * `ForYouFeed`'s multi-source gather + ranked score-cursor pipeline and
 * `FollowingFeed`'s chronological pipeline are the two families reproduced here,
 * parameterized by the definition's {@link FeedExecution} profile. Every heavy
 * collaborator is REUSED unchanged: `feedRankingService`, `threadSlicingService`,
 * `postHydrationService`, `diversifyByAuthor`, the cursors, and
 * `FeedResponseBuilder`. No new query or scoring logic lives here.
 */

import { MtnConfig } from '@mention/shared-types';
import type { HydratedPost, SlicedFeedResponse } from '@mention/shared-types';
import { feedRankingService } from '../../../services/FeedRankingService';
import { feedSeenPostsService } from '../../../services/FeedSeenPostsService';
import { postHydrationService } from '../../../services/PostHydrationService';
import { threadSlicingService } from '../../../services/ThreadSlicingService';
import { FeedResponseBuilder } from '../../../utils/FeedResponseBuilder';
import { ScoreCursor, ChronoCursor, didCursorAdvance } from '../CursorBuilder';
import { diversifyByAuthor } from '../diversifyByAuthor';
import { capDiscoveryShare } from '../capDiscoveryShare';
import {
  RankedCandidate,
  readCandidateId,
  readCandidateScore,
  sliceAuthorKey,
  sliceCursorAnchor,
  sliceIsDiscovery,
  toRankedCandidate,
} from '../rankedCandidate';
import { logger } from '../../../utils/logger';
import { recordDiscoveryGated, recordFederatedShare, originForFederation } from '../feedMetrics';
import { feedModuleRegistry, FeedModuleRegistry } from './FeedModuleRegistry';
import type {
  CandidatePost,
  FeedDefinition,
  FeedEngineContext,
  FeedExecution,
  FilterModule,
  ModuleRef,
} from './types';

export interface FeedEngineRunOptions {
  cursor?: string;
  limit: number;
}

const EMPTY_RESPONSE: SlicedFeedResponse = {
  slices: [],
  items: [],
  hasMore: false,
  nextCursor: undefined,
  totalCount: 0,
};

function readPortraitMedia(post: RankedCandidate): Array<{ type?: string; orientation?: string }> | undefined {
  if (!('content' in post)) return undefined;
  const content = Reflect.get(post, 'content');
  if (!content || typeof content !== 'object') return undefined;
  const media = Reflect.get(content, 'media');
  return Array.isArray(media) ? media : undefined;
}

function hasPortraitVideo(post: RankedCandidate): boolean {
  const media = readPortraitMedia(post);
  return Array.isArray(media)
    && media.some((item) => item?.type === 'video' && item?.orientation === 'portrait');
}

export class FeedEngine {
  constructor(private readonly registry: FeedModuleRegistry = feedModuleRegistry) {}

  async run(
    definition: FeedDefinition,
    context: FeedEngineContext,
    options: FeedEngineRunOptions,
  ): Promise<SlicedFeedResponse> {
    const exec: FeedExecution = definition.execution ?? {};
    const { cursor, limit } = options;

    // Per-request engine context the modules read.
    const ctx: FeedEngineContext = { ...context, cursor, pageLimit: limit };

    // Anonymous popular fallback (For You / Videos / Media): no viewer signals,
    // so we serve the engagement-sorted popular source directly.
    if (definition.mode === 'ranked' && exec.popularFallback && !ctx.currentUserId) {
      return this.runPopularFallback(exec.popularFallback, ctx, exec, cursor, limit);
    }

    // Seen-post de-prioritization for ranked personalized/discovery feeds.
    let parsedScoreCursor = ScoreCursor.parse(cursor);
    if (exec.seenPosts && ctx.currentUserId) {
      const seenPostIds = await feedSeenPostsService.getSeenPostIds(ctx.currentUserId);
      if (parsedScoreCursor?.id && !seenPostIds.includes(parsedScoreCursor.id)) {
        seenPostIds.push(parsedScoreCursor.id);
        feedSeenPostsService.markPostsAsSeen(ctx.currentUserId, [parsedScoreCursor.id]).catch((e) => {
          logger.warn('[FeedEngine] Failed to mark cursor post as seen', e);
        });
      }
      ctx.seenPostIds = seenPostIds;
    }

    const pool = await this.gatherPool(definition, ctx, exec, limit);

    // Phase 7: record the federated share of the merged candidate pool for this
    // feed (a gauge keyed by the base feed type). Emitted from the served `run`
    // path only — never from the cheap `peekLatest` probe — so the share reflects
    // real page builds. Non-empty guard avoids a spurious 0 on an empty pool.
    if (pool.length > 0) {
      let federatedCount = 0;
      for (const post of pool) {
        if (originForFederation(post.federation) === 'federated') federatedCount += 1;
      }
      recordFederatedShare(definition.id, federatedCount / pool.length);
    }

    return definition.mode === 'ranked'
      ? this.finalizeRanked(definition, ctx, exec, pool, cursor, limit, parsedScoreCursor)
      : this.finalizeChronological(ctx, exec, pool, cursor, limit);
  }

  /**
   * Peek at the newest item in a feed's scope for the "new posts" indicator.
   * Deliberately cheap: it gathers the definition's sources (no cursor, no seen
   * exclusion, no ranking, no slicing) and returns the single newest candidate,
   * hydrated. The safety filter still applies via the merge.
   */
  async peekLatest(definition: FeedDefinition, context: FeedEngineContext): Promise<HydratedPost | undefined> {
    const exec: FeedExecution = definition.execution ?? {};
    const ctx: FeedEngineContext = { ...context, cursor: undefined, pageLimit: 1, seenPostIds: undefined };

    const pool = await this.gatherPool(definition, ctx, exec, 1);
    if (pool.length === 0) return undefined;

    let newest = pool[0];
    let newestTs = new Date(newest.createdAt ?? 0).getTime();
    for (const post of pool) {
      const ts = new Date(post.createdAt ?? 0).getTime();
      if (ts > newestTs) {
        newest = post;
        newestTs = ts;
      }
    }

    const [hydrated] = await postHydrationService.hydratePosts([newest], {
      viewerId: ctx.currentUserId,
      oxyClient: ctx.oxyClient,
      maxDepth: exec.hydrateMaxDepth ?? 0,
      viewerGraph: this.viewerGraphOption(ctx),
    });
    return hydrated;
  }

  /**
   * Run every enabled source in parallel (soft-failing each to `[]`), then merge
   * in source order: dedupe by `_id`, drop candidates rejected by any always-on
   * filter `keep()` predicate, and bound to `exec.maxPool` when set. This
   * reproduces `gatherForYouCandidates`' merge → SFW-guard → cap loop for the For
   * You family and is a no-op merge for single-source feeds.
   *
   * DISCOVERY GATE (Phase 4a) — lane-scoped. Candidates from a NON-trusted
   * (discovery) source are additionally subjected to `definition.discoveryFilters`
   * and, when they pass, stamped with the opaque `_discovery = true` marker.
   * TRUSTED-source candidates (following / affinity / lists) skip the gate
   * entirely. Because trusted sources are listed FIRST and the merge dedupes by
   * `_id`, a post that appears in BOTH a trusted and a discovery lane is inserted
   * as the trusted (ungated, un-marked) copy — followed/affinity authors are never
   * gated. In SHADOW mode the gate is evaluated + counted but nothing is dropped.
   */
  /**
   * The viewer's social graph (following/followers) already resolved ONCE by
   * `loadViewerFeedContext`, packaged for `PostHydrationService` so hydration does
   * NOT re-fetch `getUserFollowing`/`getUserFollowers` from Oxy.
   *
   * Returns `undefined` — leaving hydration to its own live fetch — unless BOTH id
   * lists are present on the context. Only `loadViewerFeedContext` resolves the
   * full graph (it always sets `followerIds`, possibly to `[]`); the peek path
   * builds a partial context WITHOUT followers, so it must fall back to the live
   * fetch rather than silently hydrate with an empty follower set. Anonymous
   * viewers (no `currentUserId`) never thread — hydration skips the viewer-graph
   * fetch entirely when there is no viewer.
   */
  private viewerGraphOption(
    ctx: FeedEngineContext,
  ): { followingIds: string[]; followerIds: string[] } | undefined {
    if (!ctx.currentUserId) return undefined;
    if (ctx.followingIds === undefined || ctx.followerIds === undefined) return undefined;
    return { followingIds: ctx.followingIds, followerIds: ctx.followerIds };
  }

  private async gatherPool(
    definition: FeedDefinition,
    ctx: FeedEngineContext,
    exec: FeedExecution,
    limit: number,
  ): Promise<CandidatePost[]> {
    const cap = this.sourceCap(definition.mode, exec, limit);

    const enabledSources = definition.sources.filter((ref) => ref.enabled);
    const results = await Promise.allSettled(
      enabledSources.map((ref) => {
        const source = this.registry.getSource(ref.module);
        if (!source) {
          logger.warn('[FeedEngine] Unknown source module; skipping', { module: ref.module });
          return Promise.resolve<CandidatePost[]>([]);
        }
        return source.gather(ctx, ref.params ?? {}, cap);
      }),
    );

    const sourceResults: CandidatePost[][] = results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      logger.warn('[FeedEngine] Source failed; skipping', {
        module: enabledSources[i]?.module,
        error: r.reason,
      });
      return [];
    });

    // Always-on pool filters (safety, …) applied to EVERY candidate; the discovery
    // gate applies ONLY to non-trusted lanes (empty for feeds without a gate). The
    // discovery keeps carry their module id so a rejection can be attributed to the
    // exact filter (the `reason` metric label).
    const poolKeeps = this.resolveKeepPredicates(definition.filters, ctx);
    const discoveryKeeps = this.resolveKeepPredicatesWithId(definition.discoveryFilters ?? [], ctx);

    // MEASURE-ONLY when EITHER the global shadow config is on (Phase 4 ships the
    // gate in shadow so served output is unchanged until validated in prod) OR the
    // viewer is in the `gate-off` A/B cohort (Phase 7). In measure-only mode the
    // gate's rejections are counted but nothing is dropped.
    const gateShadow = MtnConfig.feed.discoveryGate.shadow === true;
    const measureOnly = gateShadow || ctx.discoveryGateBucket === 'gate-off';
    const maxPool = exec.maxPool;

    const merged = new Map<string, CandidatePost>();
    let gatedCount = 0;
    for (let i = 0; i < sourceResults.length; i += 1) {
      const sourceModule = enabledSources[i].module;
      const isTrusted = this.registry.getSource(sourceModule)?.trusted === true;
      const applyGate = !isTrusted && discoveryKeeps.length > 0;
      for (const post of sourceResults[i]) {
        if (maxPool !== undefined && merged.size >= maxPool) break;
        const id = post?._id?.toString();
        if (!id || merged.has(id)) continue;
        if (poolKeeps.some((keep) => !keep(post))) continue;

        if (applyGate) {
          // Attribute a rejection to the FIRST gate filter that rejects, so the
          // `reason` label pinpoints why (short-circuits like the engine's own
          // `.every`). A passing candidate hits none of this.
          let rejectedBy: string | undefined;
          for (const { id: filterId, keep } of discoveryKeeps) {
            if (!keep(post)) {
              rejectedBy = filterId;
              break;
            }
          }
          if (rejectedBy) {
            gatedCount += 1;
            recordDiscoveryGated(rejectedBy, sourceModule, measureOnly);
            // Enforcing mode drops the candidate; measure-only keeps it.
            if (!measureOnly) continue;
          }
          // Mark every non-trusted candidate that survives (in measure-only mode,
          // that is all of them) so ranking's discovery-scoped signals read the lane.
          post._discovery = true;
        }

        merged.set(id, post);
      }
      if (maxPool !== undefined && merged.size >= maxPool) break;
    }

    if (gatedCount > 0) {
      logger.info('[FeedEngine] discovery gate evaluated', {
        definition: definition.id,
        gated: gatedCount,
        measureOnly,
        bucket: ctx.discoveryGateBucket,
      });
    }

    return Array.from(merged.values());
  }

  /**
   * Resolve the `weightKey`s of a definition's ENABLED signal modules, forwarded
   * to `rankPosts` as `enabledSignals`. Preset feeds list only the always-on
   * signals (whose keys the ranking service composes unconditionally and ignores
   * for opt-in gating), so this is a no-op for them; a custom feed that enables an
   * OPT-IN signal (mediaBoost, positivity, …) turns that signal on here.
   */
  private resolveEnabledSignalKeys(definition: FeedDefinition): Set<string> {
    const keys = new Set<string>();
    for (const ref of definition.signals) {
      if (!ref.enabled) continue;
      const signal = this.registry.getSignal(ref.module);
      if (signal?.weightKey) keys.add(signal.weightKey);
    }
    return keys;
  }

  /** Resolve the in-memory `keep()` predicates of a set of enabled filter refs. */
  private resolveKeepPredicates(
    refs: ModuleRef[],
    ctx: FeedEngineContext,
  ): Array<(post: CandidatePost) => boolean> {
    const keeps: Array<(post: CandidatePost) => boolean> = [];
    for (const ref of refs) {
      if (!ref.enabled) continue;
      const filter: FilterModule | undefined = this.registry.getFilter(ref.module);
      const keep = filter?.keep;
      if (keep) {
        const params = ref.params ?? {};
        keeps.push((post) => keep(post, ctx, params));
      }
    }
    return keeps;
  }

  /**
   * Like {@link resolveKeepPredicates} but pairs each predicate with its module
   * id, so the discovery gate can attribute a rejection to the exact filter that
   * caused it (the `reason` metric label).
   */
  private resolveKeepPredicatesWithId(
    refs: ModuleRef[],
    ctx: FeedEngineContext,
  ): Array<{ id: string; keep: (post: CandidatePost) => boolean }> {
    const keeps: Array<{ id: string; keep: (post: CandidatePost) => boolean }> = [];
    for (const ref of refs) {
      if (!ref.enabled) continue;
      const filter: FilterModule | undefined = this.registry.getFilter(ref.module);
      const keep = filter?.keep;
      if (keep) {
        const params = ref.params ?? {};
        keeps.push({ id: ref.module, keep: (post) => keep(post, ctx, params) });
      }
    }
    return keeps;
  }

  private sourceCap(mode: FeedDefinition['mode'], exec: FeedExecution, limit: number): number {
    if (mode === 'chronological') {
      return Math.ceil(limit * (exec.overfetchMultiplier ?? 1)) + 1;
    }
    if (exec.ordered) return limit + 1;
    return limit * MtnConfig.feed.candidateMultiplier;
  }

  /**
   * Ranked finalize: rank (or accept pre-scored) → score-cursor page → thread
   * slice → author-diversity rerank → hydrate the page window → score cursor.
   * Mirrors `ForYouFeed.fetch` exactly (Videos/Media share the same pipeline).
   */
  private async finalizeRanked(
    definition: FeedDefinition,
    ctx: FeedEngineContext,
    exec: FeedExecution,
    pool: CandidatePost[],
    cursor: string | undefined,
    limit: number,
    parsedCursor: ReturnType<typeof ScoreCursor.parse>,
  ): Promise<SlicedFeedResponse> {
    if (exec.ordered) {
      return this.finalizeOrdered(ctx, exec, pool, limit);
    }

    let deduped: RankedCandidate[];

    if (exec.preScored) {
      // The single source already computed + sorted `finalScore` and applied the
      // cursor; just dedupe, preserving the score-descending source order.
      const seen = new Set<string>();
      deduped = [];
      for (const post of pool) {
        const ranked = toRankedCandidate(post);
        if (!ranked) continue;
        const id = readCandidateId(ranked);
        if (id && !seen.has(id)) {
          seen.add(id);
          deduped.push(ranked);
        }
      }
    } else {
      const rankedPosts = await feedRankingService.rankPosts(pool, ctx.currentUserId, {
        followingIds: ctx.followingIds,
        userBehavior: ctx.userBehavior,
        feedSettings: ctx.feedSettings,
        enabledSignals: this.resolveEnabledSignalKeys(definition),
        seenPostIds: ctx.seenPostIds,
        mutualIds: ctx.mutualIds,
        viewerLanguages: ctx.viewerLanguages,
      });
      const ranked: RankedCandidate[] = [];
      for (const post of rankedPosts) {
        const candidate = toRankedCandidate(post);
        if (candidate) ranked.push(candidate);
      }

      const sorted = ranked.sort((a, b) => {
        if (definition.id === 'videos') {
          const aPortrait = hasPortraitVideo(a) ? 1 : 0;
          const bPortrait = hasPortraitVideo(b) ? 1 : 0;
          if (bPortrait !== aPortrait) return bPortrait - aPortrait;
        }
        const diff = readCandidateScore(b) - readCandidateScore(a);
        if (Math.abs(diff) < MtnConfig.feed.scoreEpsilon) {
          return readCandidateId(b).localeCompare(readCandidateId(a));
        }
        return diff;
      });

      let filtered = sorted;
      if (parsedCursor && parsedCursor.score !== Infinity) {
        filtered = sorted.filter((post) => {
          const postScore = readCandidateScore(post);
          const postId = readCandidateId(post);
          if (postScore < parsedCursor.score - MtnConfig.feed.scoreEpsilon) return true;
          if (Math.abs(postScore - parsedCursor.score) < MtnConfig.feed.scoreEpsilon) {
            return postId < parsedCursor.id;
          }
          return false;
        });
      }

      const uniqueMap = new Map<string, RankedCandidate>();
      for (const post of filtered) {
        const id = readCandidateId(post);
        if (id && !uniqueMap.has(id)) uniqueMap.set(id, post);
      }
      deduped = Array.from(uniqueMap.values());
    }

    // Never-blank: an authenticated ranked personalized feed that exhausts its
    // unseen pool falls back to popular discovery instead of returning blank.
    if (deduped.length === 0 && exec.neverBlank && exec.popularFallback && ctx.currentUserId) {
      return this.runPopularFallback(exec.popularFallback, ctx, exec, cursor, limit);
    }

    const { slices: rawSlices } = await threadSlicingService.sliceFeed(deduped, {
      enableThreadGrouping: exec.threadGrouping !== false,
      enableReplyContext: exec.replyContext === true,
      maxSliceSize: MtnConfig.feed.maxSliceSize,
      viewerId: ctx.currentUserId,
    });

    const diversifiedSlices = diversifyByAuthor(rawSlices, sliceAuthorKey);

    // Phase 5: cap the discovery share of the page (For You sets
    // `maxDiscoveryShare`; every other feed leaves it unset → no-op). Runs AFTER
    // author diversification and BEFORE truncation; it DEFERS discovery overflow to
    // the tail (never drops), so `hasMore` / cursor semantics are unchanged.
    const cappedSlices = capDiscoveryShare(
      diversifiedSlices,
      sliceIsDiscovery,
      exec.maxDiscoveryShare,
      limit,
    );

    const hasMore = cappedSlices.length > limit;
    const pageSlices = hasMore ? cappedSlices.slice(0, limit) : cappedSlices;

    const hydratedSlices = await postHydrationService.hydrateSlices(pageSlices, {
      viewerId: ctx.currentUserId,
      oxyClient: ctx.oxyClient,
      maxDepth: exec.hydrateMaxDepth ?? 0,
      includeLinkMetadata: true,
      viewerGraph: this.viewerGraphOption(ctx),
    });

    if (exec.seenPosts && ctx.currentUserId) {
      this.markSlicesSeen(ctx.currentUserId, hydratedSlices);
    }

    let sliceCursor: string | undefined;
    if (pageSlices.length > 0 && hasMore) {
      let anchorScore = Infinity;
      let anchorId: string | undefined;
      for (const slice of pageSlices) {
        const anchor = sliceCursorAnchor(slice);
        if (!anchor) continue;
        if (anchor.score < anchorScore) {
          anchorScore = anchor.score;
          anchorId = anchor.id;
        }
      }
      if (anchorId && anchorScore !== Infinity) {
        sliceCursor = ScoreCursor.build(anchorScore, anchorId);
        if (!didCursorAdvance(sliceCursor, cursor)) {
          logger.warn('[FeedEngine] Ranked cursor did not advance', { cursor, nextCursor: sliceCursor });
          sliceCursor = undefined;
        }
      }
    }

    return FeedResponseBuilder.buildSlicedResponse({
      slices: hydratedSlices,
      limit,
      previousCursor: cursor,
      cursorFromLastSlice: sliceCursor,
      hasMore,
    });
  }

  /**
   * Chronological finalize: sort by recency, thread slice, hydrate, chrono
   * cursor. Mirrors `FollowingFeed.fetch` (Hashtag/Author/List/Topic share it).
   * The source has already applied the cursor + `_id`-sort + fetch limit; the
   * engine re-sorts by `createdAt` for multi-source unions and pages via the
   * overfetch flag.
   */
  private async finalizeChronological(
    ctx: FeedEngineContext,
    exec: FeedExecution,
    pool: CandidatePost[],
    cursor: string | undefined,
    limit: number,
  ): Promise<SlicedFeedResponse> {
    if (exec.ordered) {
      return this.finalizeOrdered(ctx, exec, pool, limit);
    }

    if (pool.length === 0) return { ...EMPTY_RESPONSE };

    const sorted = pool.slice().sort((a, b) => {
      const at = new Date(a.createdAt ?? 0).getTime();
      const bt = new Date(b.createdAt ?? 0).getTime();
      if (bt !== at) return bt - at;
      return String(b._id).localeCompare(String(a._id));
    });

    const fetchLimit = Math.ceil(limit * (exec.overfetchMultiplier ?? 1));
    const hasMore = sorted.length > fetchLimit;
    const postsToProcess = hasMore ? sorted.slice(0, fetchLimit) : sorted;

    const { slices: rawSlices } = await threadSlicingService.sliceFeed(postsToProcess, {
      enableThreadGrouping: exec.threadGrouping !== false,
      enableReplyContext: exec.replyContext === true,
      maxSliceSize: MtnConfig.feed.maxSliceSize,
      viewerId: ctx.currentUserId,
    });

    const hydratedSlices = await postHydrationService.hydrateSlices(rawSlices, {
      viewerId: ctx.currentUserId,
      oxyClient: ctx.oxyClient,
      maxDepth: exec.hydrateMaxDepth ?? 0,
      includeLinkMetadata: true,
      viewerGraph: this.viewerGraphOption(ctx),
    });

    let nextCursor: string | undefined;
    if (postsToProcess.length > 0 && hasMore) {
      const last = postsToProcess[postsToProcess.length - 1];
      nextCursor = ChronoCursor.build(String(last._id), last.createdAt);
      if (!didCursorAdvance(nextCursor, cursor)) {
        logger.warn('[FeedEngine] Chronological cursor did not advance', { cursor, nextCursor });
        nextCursor = undefined;
      }
    }

    return FeedResponseBuilder.buildSlicedResponse({
      slices: hydratedSlices,
      limit,
      previousCursor: cursor,
      cursorFromLastSlice: nextCursor,
      hasMore,
    });
  }

  /**
   * Ordered finalize (Saved, Author-likes): the source returns the page's
   * candidates already in the correct order and stamps `_feedCursor` on the last
   * one when more pages exist. The engine hydrates them as flat items — no
   * ranking, no slicing.
   */
  private async finalizeOrdered(
    ctx: FeedEngineContext,
    exec: FeedExecution,
    pool: CandidatePost[],
    limit: number,
  ): Promise<SlicedFeedResponse> {
    if (pool.length === 0) return { ...EMPTY_RESPONSE };

    const page = pool.slice(0, limit);
    const nextCursor = page[page.length - 1]?._feedCursor;
    const hasMore = Boolean(nextCursor);

    const hydrated = await postHydrationService.hydratePosts(page, {
      viewerId: ctx.currentUserId,
      oxyClient: ctx.oxyClient,
      maxDepth: exec.hydrateMaxDepth ?? 0,
      includeLinkMetadata: true,
      viewerGraph: this.viewerGraphOption(ctx),
    });

    if (exec.markSaved) {
      for (const post of hydrated) {
        if (post.viewerState) post.viewerState.isSaved = true;
      }
    }

    return {
      slices: [],
      items: hydrated,
      hasMore,
      nextCursor,
      totalCount: hydrated.length,
    };
  }

  /**
   * Popular fallback for the anonymous + never-blank paths (For You / Videos /
   * Media): serve the engagement-sorted popular source directly, hydrated as
   * flat items with `viewerId: undefined` (matching the bespoke `fetchPopular`).
   */
  private async runPopularFallback(
    popularSourceId: string,
    ctx: FeedEngineContext,
    exec: FeedExecution,
    cursor: string | undefined,
    limit: number,
  ): Promise<SlicedFeedResponse> {
    const source = this.registry.getSource(popularSourceId);
    if (!source) {
      logger.warn('[FeedEngine] Popular fallback source missing', { module: popularSourceId });
      return { ...EMPTY_RESPONSE };
    }

    const candidates = await source.gather({ ...ctx, cursor, pageLimit: limit }, {}, limit + 1);
    const hasMore = candidates.length > limit;
    const page = hasMore ? candidates.slice(0, limit) : candidates;
    const nextCursor = hasMore && page.length > 0 ? String(page[page.length - 1]._id) : undefined;

    const hydrated = await postHydrationService.hydratePosts(page, {
      viewerId: undefined,
      oxyClient: ctx.oxyClient,
      maxDepth: exec.hydrateMaxDepth ?? 0,
      includeLinkMetadata: true,
    });

    return {
      slices: [],
      items: hydrated,
      hasMore,
      nextCursor,
      totalCount: hydrated.length,
    };
  }

  /** Mark every hydrated post in the emitted page as seen (fire and forget). */
  private markSlicesSeen(userId: string, slices: SlicedFeedResponse['slices']): void {
    const allPostIds: string[] = [];
    for (const slice of slices) {
      for (const item of slice.items) {
        const id = item.post?.id?.toString();
        if (id && id !== 'undefined' && id !== 'null') allPostIds.push(id);
      }
    }
    if (allPostIds.length > 0) {
      feedSeenPostsService.markPostsAsSeen(userId, allPostIds).catch((e) => {
        logger.warn('[FeedEngine] Failed to mark posts as seen', e);
      });
    }
  }
}

export const feedEngine = new FeedEngine();
