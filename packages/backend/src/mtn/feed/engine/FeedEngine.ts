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
import type { SlicedFeedResponse } from '@mention/shared-types';
import { feedRankingService } from '../../../services/FeedRankingService';
import { feedSeenPostsService } from '../../../services/FeedSeenPostsService';
import { postHydrationService } from '../../../services/PostHydrationService';
import { threadSlicingService } from '../../../services/ThreadSlicingService';
import { FeedResponseBuilder } from '../../../utils/FeedResponseBuilder';
import { ScoreCursor, ChronoCursor, didCursorAdvance } from '../CursorBuilder';
import { diversifyByAuthor } from '../diversifyByAuthor';
import {
  RankedCandidate,
  readCandidateId,
  readCandidateScore,
  sliceAuthorKey,
  sliceCursorAnchor,
} from '../rankedCandidate';
import { logger } from '../../../utils/logger';
import { feedModuleRegistry, FeedModuleRegistry } from './FeedModuleRegistry';
import type {
  CandidatePost,
  FeedDefinition,
  FeedEngineContext,
  FeedExecution,
  FilterModule,
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

    return definition.mode === 'ranked'
      ? this.finalizeRanked(definition, ctx, exec, pool, cursor, limit, parsedScoreCursor)
      : this.finalizeChronological(ctx, exec, pool, cursor, limit);
  }

  /**
   * Run every enabled source in parallel (soft-failing each to `[]`), then merge
   * in source order: dedupe by `_id`, drop candidates rejected by any filter
   * `keep()` predicate, and bound to `exec.maxPool` when set. This reproduces
   * `gatherForYouCandidates`' merge → SFW-guard → cap loop for the For You family
   * and is a no-op merge for single-source feeds.
   */
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

    const keeps = this.resolveKeepPredicates(definition, ctx);
    const maxPool = exec.maxPool;

    const merged = new Map<string, CandidatePost>();
    for (const posts of sourceResults) {
      for (const post of posts) {
        if (maxPool !== undefined && merged.size >= maxPool) break;
        const id = post?._id?.toString();
        if (!id || merged.has(id)) continue;
        if (keeps.some((keep) => !keep(post))) continue;
        merged.set(id, post);
      }
      if (maxPool !== undefined && merged.size >= maxPool) break;
    }

    return Array.from(merged.values());
  }

  /** Resolve the in-memory `keep()` predicates of the definition's enabled filters. */
  private resolveKeepPredicates(
    definition: FeedDefinition,
    ctx: FeedEngineContext,
  ): Array<(post: CandidatePost) => boolean> {
    const keeps: Array<(post: CandidatePost) => boolean> = [];
    for (const ref of definition.filters) {
      if (!ref.enabled) continue;
      const filter: FilterModule | undefined = this.registry.getFilter(ref.module);
      if (filter?.keep) {
        const params = ref.params ?? {};
        keeps.push((post) => filter.keep!(post, ctx, params));
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
      for (const post of pool as unknown as RankedCandidate[]) {
        const id = readCandidateId(post);
        if (id && !seen.has(id)) {
          seen.add(id);
          deduped.push(post);
        }
      }
    } else {
      const ranked = (await feedRankingService.rankPosts(pool, ctx.currentUserId, {
        followingIds: ctx.followingIds,
        userBehavior: ctx.userBehavior,
        feedSettings: ctx.feedSettings,
        ...(exec.passSensitiveOptIn ? { showSensitiveContent: ctx.showSensitiveContent === true } : {}),
      })) as RankedCandidate[];

      const sorted = ranked.sort((a, b) => {
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

    const hasMore = diversifiedSlices.length > limit;
    const pageSlices = hasMore ? diversifiedSlices.slice(0, limit) : diversifiedSlices;

    const hydratedSlices = await postHydrationService.hydrateSlices(pageSlices, {
      viewerId: ctx.currentUserId,
      oxyClient: ctx.oxyClient,
      maxDepth: exec.hydrateMaxDepth ?? 0,
      includeLinkMetadata: true,
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
    });

    let nextCursor: string | undefined;
    if (postsToProcess.length > 0 && hasMore) {
      const last = postsToProcess[postsToProcess.length - 1];
      nextCursor = ChronoCursor.build(String(last._id), last.createdAt as Date | string | undefined);
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
