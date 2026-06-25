import { FeedPostSlice, FeedSliceItem, HydratedPost, HydratedPostSummary, HydratedBoostContext, PostActorSummary, PostAttachmentBundle, PostEngagementSummary, PostLinkPreview, PostPermissions, PostViewerState, PostVisibility } from '@mention/shared-types';
import mongoose from 'mongoose';
import { Post } from '../models/Post';
import Poll from '../models/Poll';
import Like from '../models/Like';
import Bookmark from '../models/Bookmark';
import FederatedActor from '../models/FederatedActor';
import { UserSettings } from '../models/UserSettings';
import { oxy as defaultOxyClient } from '../../server';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { linkMetadataService } from './linkMetadataService';
import { readPreviews, storePreview, markNoPreview } from './linkPreviewCache';
import { getBlockedUserIds, getRestrictedUserIds, extractFollowingIds, extractFollowersIds, OxyClient } from '../utils/privacyHelpers';
import { resolveAvatarUrl, resolveMediaItems } from '../utils/mediaResolver';
import { logger } from '../utils/logger';
import type { User as OxyUser } from '@oxyhq/core';
import { assignThreadState } from './ThreadSlicingService';
import { mget as mgetUserSummaries, mset as msetUserSummaries, CachedUserSummary } from './userSummaryCache';

import { PostContent, PostMetadata } from '@mention/shared-types';

/**
 * A raw post plain-object as returned by `.lean()` or `.toObject()`.
 * Covers all fields accessed during hydration, including federated-only fields.
 */
interface RawPost {
  _id?: unknown;
  id?: string;
  oxyUserId?: string;
  content?: Partial<PostContent>;
  metadata?: Partial<PostMetadata>;
  stats?: {
    likesCount?: number;
    downvotesCount?: number;
    boostsCount?: number;
    commentsCount?: number;
    viewsCount?: number;
  };
  boostOf?: unknown;
  quoteOf?: unknown;
  originalPostId?: unknown;
  parentPostId?: unknown;
  threadId?: unknown;
  replyPermission?: string[];
  reviewReplies?: boolean;
  quotesDisabled?: boolean;
  hashtags?: string[];
  mentions?: unknown[];
  tags?: string[];
  visibility?: string;
  status?: string;
  language?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
  date?: unknown;
  /** Allow additional fields from lean/toObject results */
  [key: string]: unknown;
}

interface HydrationOptions {
  viewerId?: string;
  oxyClient?: OxyClient; // Per-request OxyServices instance with user's auth token
  maxDepth?: number;
  includeLinkMetadata?: boolean;
  includeFullArticleBody?: boolean; // For feed, skip full article bodies
  includeFullMetadata?: boolean; // For feed, skip some metadata fields
}

interface HydratedGraphNode {
  post: RawPost;
  depth: number;
}

interface ViewerContext {
  viewerId?: string;
  privacyPreferences: {
    hideLikeCounts: boolean;
    hideShareCounts: boolean;
    hideReplyCounts: boolean;
    hideSaveCounts: boolean;
  };
  blockedIds: Set<string>;
  restrictedIds: Set<string>;
  follows: Set<string>;
  followedBy: Set<string>;
  likedPosts: Set<string>;
  downvotedPosts: Set<string>;
  savedPosts: Set<string>;
  boostedPosts: Set<string>;
  /** Author IDs with private or followers_only profile visibility */
  privateProfileIds: Set<string>;
}

interface ExtendedViewerContext extends ViewerContext {
  includeFullArticleBody?: boolean;
  includeFullMetadata?: boolean;
  _authorPrivacyCache?: Map<string, typeof DEFAULT_PRIVACY>;
}

const DEFAULT_PRIVACY = {
  hideLikeCounts: false,
  hideShareCounts: false,
  hideReplyCounts: false,
  hideSaveCounts: false,
};

/**
 * URLs currently being resolved in the background by {@link PostHydrationService.warmLinkPreviews}.
 * Single-flight guard so concurrent feed requests never fetch the same remote
 * page more than once. Process-local (sufficient — entries are short-lived and
 * the cache itself is shared via Redis); cleared in the warm task's `finally`.
 */
const linkPreviewWarmInflight = new Set<string>();

/**
 * Build the ready-to-render {@link CachedUserSummary} (author summary + follower
 * count) from a raw Oxy user. Centralized so the per-id fallback path and the
 * bulk path produce IDENTICAL output, and so the same shape is what we cache.
 */
function summaryFromOxyUser(userId: string, userData: OxyUser): CachedUserSummary {
  const username: string = String(userData?.username || userData?.handle || userId);
  const displayName: string = userData.name.displayName;
  const profileImage = (userData as { profileImage?: unknown }).profileImage;
  const rawAvatar: string | undefined = typeof userData?.avatar === 'string'
    ? userData.avatar
    : typeof profileImage === 'string'
      ? profileImage
      : undefined;
  const avatarValue = resolveAvatarUrl(rawAvatar);

  const isFederated = Boolean((userData as Record<string, unknown>)?.isFederated);
  const federation = (userData as Record<string, unknown>)?.federation as { domain?: string } | undefined;
  const followerCount = userData._count?.followers;

  return {
    summary: {
      id: String(userData?.id || userId),
      handle: username,
      displayName,
      avatarUrl: avatarValue,
      avatar: avatarValue,
      badges: Array.isArray(userData.badges)
        ? userData.badges.map((badge) => (typeof badge === 'string' ? badge : (badge as Record<string, unknown>)?.name as string | undefined)).filter((b): b is string => typeof b === 'string')
        : undefined,
      isVerified: Boolean(userData.verified || userData.isVerified),
      isFederated: isFederated || undefined,
      instance: isFederated ? federation?.domain : undefined,
    },
    followerCount: typeof followerCount === 'number' ? followerCount : undefined,
  };
}

/** A minimal, safe summary used when an author cannot be resolved from Oxy. */
function fallbackSummary(userId: string): CachedUserSummary {
  return {
    summary: {
      id: userId,
      handle: userId,
      displayName: userId,
      avatarUrl: undefined,
      avatar: undefined,
      badges: undefined,
      isVerified: false,
    },
  };
}

/**
 * Whether a summary is the {@link fallbackSummary} produced when a user could
 * not be resolved from Oxy (handle === displayName === id). Mentions that only
 * resolve to a fallback must be left as their raw placeholder rather than
 * rendered with the raw id as a name. Kept in lockstep with `fallbackSummary`.
 */
function isFallbackUserSummary(userId: string, summary: PostActorSummary): boolean {
  return summary.handle === userId && summary.displayName === userId;
}

/**
 * Resolve {@link CachedUserSummary} for a set of Oxy user ids, collapsing the
 * classic feed M+1 (one `getUserById` per unique author) into:
 *   1. a single batched read of the Redis user-summary cache, then
 *   2. a single bulk service-token Oxy fetch for the MISSES (`getUsersByIds`
 *      via the service client; per-id `getUserById` fallback on error or for
 *      any id the bulk call does not return), then
 *   3. a single batched write of the freshly-resolved summaries back to cache.
 *
 * Cache hits never touch Oxy. Misses that error fall back to a minimal summary
 * (and are NOT cached, so they re-resolve next time). Shared by hydration
 * ({@link PostHydrationService.buildUserMap}) and the ranking authority signal.
 */
export async function resolveUserSummaries(userIds: string[]): Promise<Map<string, CachedUserSummary>> {
  const resolved = new Map<string, CachedUserSummary>();
  if (userIds.length === 0) {
    return resolved;
  }

  // 1. Batched cache read.
  const cached = await mgetUserSummaries(userIds);
  const missIds: string[] = [];
  for (const userId of userIds) {
    const hit = cached.get(userId);
    if (hit) {
      resolved.set(userId, hit);
    } else {
      missIds.push(userId);
    }
  }

  if (missIds.length === 0) {
    return resolved;
  }

  // 2. Resolve misses from Oxy with a single bulk service-token call. The
  //    `/users/by-ids` endpoint is server-to-server, so it must be called via
  //    the service client (carries the app bearer token). Any id the bulk call
  //    does not return — and a whole-call failure — falls back to the per-id
  //    GET, which works unauthenticated for public user data.
  const freshlyResolved = new Map<string, CachedUserSummary>();

  const resolvePerId = async (ids: string[]): Promise<void> => {
    await Promise.all(
      ids.map(async (userId) => {
        try {
          const userData: OxyUser = await defaultOxyClient.getUserById(userId);
          freshlyResolved.set(userId, summaryFromOxyUser(userId, userData));
        } catch (error) {
          logger.warn(`[PostHydration] Failed to load user ${userId}:`, error);
          resolved.set(userId, fallbackSummary(userId));
        }
      }),
    );
  };

  try {
    const users = await getServiceOxyClient().getUsersByIds(missIds);
    const byId = new Map<string, OxyUser>();
    for (const user of users) {
      const id = String((user as { id?: unknown }).id ?? '');
      if (id) byId.set(id, user);
    }
    const unresolved: string[] = [];
    for (const userId of missIds) {
      const userData = byId.get(userId);
      if (userData) {
        freshlyResolved.set(userId, summaryFromOxyUser(userId, userData));
      } else {
        unresolved.push(userId);
      }
    }
    if (unresolved.length > 0) {
      await resolvePerId(unresolved);
    }
  } catch (error) {
    logger.warn('[PostHydration] Bulk user fetch failed, falling back to per-id', {
      count: missIds.length,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    await resolvePerId(missIds);
  }

  // 3. Merge fresh results and write them back to cache (only real resolutions).
  for (const [userId, value] of freshlyResolved) {
    resolved.set(userId, value);
  }
  if (freshlyResolved.size > 0) {
    await msetUserSummaries(freshlyResolved);
  }

  return resolved;
}

export class PostHydrationService {
  async hydratePosts(rawPosts: object[], options: HydrationOptions = {}): Promise<HydratedPost[]> {
    if (!Array.isArray(rawPosts) || rawPosts.length === 0) {
      return [];
    }

    const maxDepth = Math.max(0, options.maxDepth ?? 1);
    const viewerContext = await this.buildViewerContext(rawPosts, options.viewerId, options);

    const initialPosts = rawPosts
      .map((p): RawPost => (typeof (p as { toObject?: () => RawPost }).toObject === 'function' ? (p as { toObject: () => RawPost }).toObject() : p as RawPost))
      .filter((post) => post && post.oxyUserId
        && !viewerContext.blockedIds.has(String(post.oxyUserId)));

    if (initialPosts.length === 0) {
      return [];
    }

    const graph = await this.collectPostsWithDepth(initialPosts, maxDepth, viewerContext.blockedIds);

    const postIds = Array.from(graph.keys());
    const postsForHydration = Array.from(graph.values());

    // Run independent hydration steps in parallel to minimize waterfall latency.
    // Dependency chain: aggregateRecentReplierIds → buildUserMap → buildReplierAvatarsFromUserMap
    // Everything else is independent and can run concurrently.
    const [
      ,
      { userMap, recentReplierMap },
      pollMap,
      authorPrivacyMap,
      linkPreviewMap,
      federatedAuthorMap,
    ] = await Promise.all([
      this.populateViewerInteractions(postIds, viewerContext),
      (async () => {
        const replierAggResult = await this.aggregateRecentReplierIds(postIds);
        const uMap = await this.buildUserMap(postsForHydration, replierAggResult.allReplierIds);
        const rMap = this.buildReplierAvatarsFromUserMap(replierAggResult.perPostRepliers, uMap);
        return { userMap: uMap, recentReplierMap: rMap };
      })(),
      this.buildPollMap(postsForHydration),
      this.buildAuthorPrivacyMap(postsForHydration, viewerContext),
      options.includeLinkMetadata !== false
        ? this.buildLinkPreviewMap(postsForHydration)
        : Promise.resolve(new Map<string, PostLinkPreview>()),
      this.buildFederatedAuthorMap(postsForHydration),
    ]);
    const mentionCache: Map<string, PostActorSummary> = new Map(userMap);

    const summaryMap = new Map<string, HydratedPostSummary>();

    const summaries = await Promise.all(
      postsForHydration.map(({ post }) =>
        this.buildPostSummary({
          post,
          viewerContext,
          pollMap,
          userMap,
          mentionCache,
          linkPreviewMap,
          authorPrivacyMap,
          recentReplierMap,
          federatedAuthorMap,
        })
      )
    );
    for (const summary of summaries) {
      if (summary) {
        summaryMap.set(summary.id, summary);
      }
    }

    const hydratedResults: HydratedPost[] = [];

    for (const { post, depth } of postsForHydration) {
      if (depth !== 0) continue;
      const postId = this.resolveId(post);
      const summary = summaryMap.get(postId);
      if (!summary) continue;

      const hydrated = this.attachNestedContext(post, summary, summaryMap, viewerContext);
      if (hydrated) {
        hydratedResults.push(hydrated);
      }
    }

    return hydratedResults;
  }

  /**
   * Hydrate all posts across multiple slices in a single batch,
   * then reconstruct slices with hydrated data.
   * This prevents per-slice hydration overhead (N+1 at the slice level).
   */
  async hydrateSlices(
    slices: FeedPostSlice[],
    options: HydrationOptions = {}
  ): Promise<FeedPostSlice[]> {
    if (slices.length === 0) return [];

    // Collect ALL posts from ALL slices into a flat array for batch hydration
    const allRawPosts: object[] = [];
    const postIdToSlicePositions = new Map<string, Array<{ sliceIdx: number; itemIdx: number }>>();

    for (let si = 0; si < slices.length; si++) {
      for (let ii = 0; ii < slices[si].items.length; ii++) {
        const rawPost = slices[si].items[ii].post as unknown as RawPost;
        const postId = (rawPost?.id as string | undefined) || (rawPost?._id ? String(rawPost._id) : '') || '';
        if (!postId) continue;

        allRawPosts.push(rawPost);
        if (!postIdToSlicePositions.has(postId)) {
          postIdToSlicePositions.set(postId, []);
        }
        postIdToSlicePositions.get(postId)!.push({ sliceIdx: si, itemIdx: ii });
      }
    }

    // Hydrate all posts in one batch
    const hydratedPosts = await this.hydratePosts(allRawPosts, options);

    // Build lookup: postId → HydratedPost
    const hydratedMap = new Map<string, HydratedPost>();
    for (const hp of hydratedPosts) {
      hydratedMap.set(hp.id, hp);
    }

    // Reconstruct slices with hydrated data
    const result: FeedPostSlice[] = [];
    for (const slice of slices) {
      const hydratedItems: FeedSliceItem[] = [];
      for (const item of slice.items) {
        const itemPost = item.post as unknown as RawPost;
        const postId = (itemPost?.id as string | undefined) || (itemPost?._id ? String(itemPost._id) : '') || '';
        const hydrated = hydratedMap.get(postId);
        if (hydrated) {
          hydratedItems.push({
            ...item,
            post: hydrated,
          });
        }
      }

      // Only include slices that have at least one hydrated item
      if (hydratedItems.length > 0) {
        // Recalculate thread state after filtering (items may have been dropped)
        const recalculated = assignThreadState(hydratedItems);

        // Recompute slice key only if items were dropped during hydration
        const sliceKey = hydratedItems.length === slice.items.length
          ? slice._sliceKey
          : recalculated.map((i) => i.post.id).join('+');

        result.push({
          ...slice,
          _sliceKey: sliceKey,
          items: recalculated,
        });
      }
    }

    return result;
  }

  private async buildViewerContext(posts: object[], viewerId?: string, options?: HydrationOptions): Promise<ExtendedViewerContext> {
    const context: ExtendedViewerContext = {
      viewerId,
      privacyPreferences: { ...DEFAULT_PRIVACY },
      blockedIds: new Set<string>(),
      restrictedIds: new Set<string>(),
      follows: new Set<string>(),
      followedBy: new Set<string>(),
      likedPosts: new Set<string>(),
      downvotedPosts: new Set<string>(),
      savedPosts: new Set<string>(),
      boostedPosts: new Set<string>(),
      privateProfileIds: new Set<string>(),
      includeFullArticleBody: options?.includeFullArticleBody ?? true,
      includeFullMetadata: options?.includeFullMetadata ?? true,
    };

    // Collect unique author IDs for profile visibility check
    const authorIds = Array.from(
      new Set(posts.map((p) => (p as RawPost)?.oxyUserId).filter(Boolean).map((id) => String(id))),
    );

    // Load ALL author settings in one query (profile visibility + engagement privacy)
    // This avoids a separate query in buildAuthorPrivacyMap
    if (authorIds.length > 0) {
      try {
        const allAuthorSettings = await UserSettings.find({
          oxyUserId: { $in: authorIds },
        }).lean();

        // Pre-populate author privacy map for reuse in buildAuthorPrivacyMap
        const authorPrivacyCache = new Map<string, typeof DEFAULT_PRIVACY>();
        for (const s of allAuthorSettings) {
          const authorId = String(s.oxyUserId);

          // Track private profiles
          const vis = s.privacy?.profileVisibility;
          if (vis === 'private' || vis === 'followers_only') {
            context.privateProfileIds.add(authorId);
          }

          // Cache engagement privacy for buildAuthorPrivacyMap
          authorPrivacyCache.set(authorId, {
            hideLikeCounts: Boolean(s.privacy?.hideLikeCounts),
            hideShareCounts: Boolean(s.privacy?.hideShareCounts),
            hideReplyCounts: Boolean(s.privacy?.hideReplyCounts),
            hideSaveCounts: Boolean(s.privacy?.hideSaveCounts),
          });
        }

        // Set defaults for authors without settings
        for (const authorId of authorIds) {
          if (!authorPrivacyCache.has(authorId)) {
            authorPrivacyCache.set(authorId, { ...DEFAULT_PRIVACY });
          }
        }

        context._authorPrivacyCache = authorPrivacyCache;
      } catch (error) {
        logger.warn('[PostHydration] Failed to load author settings:', error);
      }
    }

    if (!viewerId) {
      return context;
    }

    const client = options?.oxyClient;

    try {
      const [blockedIds, restrictedIds] = await Promise.all([
        getBlockedUserIds(client).catch((error) => {
          logger.warn('[PostHydration] Failed to load blocked users:', error);
          return [] as string[];
        }),
        getRestrictedUserIds(client).catch((error) => {
          logger.warn('[PostHydration] Failed to load restricted users:', error);
          return [] as string[];
        }),
      ]);

      blockedIds.forEach((id) => context.blockedIds.add(String(id)));
      restrictedIds.forEach((id) => context.restrictedIds.add(String(id)));
    } catch (error) {
      logger.warn('[PostHydration] Privacy list retrieval failed:', error);
    }

    try {
      const settings = await UserSettings.findOne({ oxyUserId: viewerId }).lean();
      if (settings?.privacy) {
        context.privacyPreferences = {
          hideLikeCounts: Boolean(settings.privacy.hideLikeCounts),
          hideShareCounts: Boolean(settings.privacy.hideShareCounts),
          hideReplyCounts: Boolean(settings.privacy.hideReplyCounts),
          hideSaveCounts: Boolean(settings.privacy.hideSaveCounts),
        };
      }
    } catch (error) {
      logger.warn('[PostHydration] Failed to load viewer privacy settings:', error);
    }

    try {
      const oxyForFollows = client || defaultOxyClient;
      const [followingResponse, followersResponse] = await Promise.all([
        oxyForFollows.getUserFollowing(viewerId).catch((error: unknown) => {
          logger.warn('[PostHydration] getUserFollowing failed:', error);
          return [];
        }),
        oxyForFollows.getUserFollowers(viewerId).catch((error: unknown) => {
          logger.warn('[PostHydration] getUserFollowers failed:', error);
          return [];
        }),
      ]);

      extractFollowingIds(followingResponse).forEach((id) => context.follows.add(String(id)));
      extractFollowersIds(followersResponse).forEach((id) => context.followedBy.add(String(id)));
    } catch (error) {
      logger.warn('[PostHydration] Failed to load follower/following context:', error);
    }

    return context;
  }

  // A boost-of-boost chain (Announce of an Announce) is collected one extra hop
  // beyond `maxDepth` per the forced-boost-original rule below, but is then
  // capped so a pathological chain cannot fan out unbounded. Two levels is
  // enough to render a boost of a boost (its own original embeds); deeper
  // chains keep their nested original empty rather than over-fetching.
  private static readonly MAX_FORCED_BOOST_DEPTH = 2;

  private async collectPostsWithDepth(
    initialPosts: RawPost[],
    maxDepth: number,
    blockedIds: Set<string>,
  ): Promise<Map<string, HydratedGraphNode>> {
    const result = new Map<string, HydratedGraphNode>();
    const visited = new Set<string>();

    let currentLevel = initialPosts.map((post): HydratedGraphNode => ({ post, depth: 0 }));

    // The collection runs at least one level beyond `maxDepth` so a boost's
    // mandatory original (forced below, regardless of `maxDepth`) is always
    // fetched. The per-entry guards still respect `maxDepth` for OPTIONAL
    // references, so this added iteration only ever fetches forced boost
    // originals — never expands the normal depth budget.
    const collectionDepthCap = Math.max(maxDepth, PostHydrationService.MAX_FORCED_BOOST_DEPTH);

    for (let depth = 0; depth <= collectionDepthCap && currentLevel.length > 0; depth++) {
      const nextIdMap = new Map<string, number>();

      for (const entry of currentLevel) {
        const id = this.resolveId(entry.post);
        if (!id || visited.has(id)) continue;
        visited.add(id);

        const authorId = entry.post?.oxyUserId ? String(entry.post.oxyUserId) : undefined;
        if (authorId && blockedIds.has(authorId)) {
          continue;
        }

        result.set(id, { post: entry.post, depth: entry.depth });

        const enqueueRef = (refId: string) => {
          if (!refId || visited.has(refId)) return;
          const nextDepth = entry.depth + 1;
          const existing = nextIdMap.get(refId);
          nextIdMap.set(refId, existing === undefined ? nextDepth : Math.min(existing, nextDepth));
        };

        // A `type:'boost'` post has an intentionally EMPTY content body and is
        // NOT renderable without its boosted original — the original is part of
        // the boost's own content, not optional nested context. So ALWAYS
        // collect a boost's direct `boostOf` original one hop deep, independent
        // of the caller's `maxDepth`. Without this, any endpoint that hydrates
        // boosts at `maxDepth: 0` (most feed paths) silently returns a blank
        // boost. Bounded by `collectionDepthCap` so a boost-of-boost chain
        // cannot fan out indefinitely.
        if (entry.depth < collectionDepthCap) {
          const forcedOriginalId = this.extractBoostOriginalId(entry.post);
          if (forcedOriginalId) {
            enqueueRef(forcedOriginalId);
          }
        }

        // OPTIONAL references (quote, legacy originalPostId) still respect the
        // caller's `maxDepth` budget — they are nested context, not mandatory
        // content, so a `maxDepth: 0` caller intentionally omits them.
        if (entry.depth < maxDepth) {
          for (const refId of this.extractReferenceIds(entry.post)) {
            enqueueRef(refId);
          }
        }
      }

      if (nextIdMap.size === 0) {
        break;
      }

      const nextIds = Array.from(nextIdMap.keys());
      try {
        const fetched = await Post.find({ _id: { $in: nextIds } })
          .select('-metadata.likedBy -metadata.savedBy -translations')
          .lean();

        currentLevel = fetched.map((post) => ({
          post: post as unknown as RawPost,
          depth: nextIdMap.get(this.resolveId(post as unknown as RawPost)!) ?? depth + 1,
        }));
      } catch (error) {
        logger.error('[PostHydration] Failed to fetch referenced posts:', error);
        break;
      }
    }

    return result;
  }

  /**
   * Resolve a boost's DIRECT original post id (`boostOf`), if any. Unlike
   * {@link extractReferenceIds} this returns only the mandatory boost original
   * (never the optional quote/originalPostId references), so the forced
   * collection in {@link collectPostsWithDepth} pulls exactly the one post a
   * boost cannot render without.
   */
  private extractBoostOriginalId(post: RawPost): string | undefined {
    const value = post?.boostOf;
    if (!value) return undefined;
    if (typeof value === 'string') return value || undefined;
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const refId = obj._id ?? obj.id ?? obj.postId;
      if (refId) return String(refId);
    }
    return undefined;
  }

  /**
   * Build the per-post REMOTE-actor map for FEDERATED posts whose `oxyUserId` was
   * never linked to an Oxy user (orphaned actor). Such a post is public and
   * physically exists, so it must render with a real author rather than a blank
   * row (most visibly: a boost of such a post, whose body is empty by design).
   *
   * Resolution honors the canonical identity contract: the orphaned author is
   * the REMOTE {@link FederatedActor}, so its real `displayName` and remote
   * `avatarUrl` are carried through. The link from post → actor follows the same
   * convention the `/federation/actor/posts` route uses: a `FederatedActor.uri`
   * is a PREFIX of the post's `federation.activityId`. Actors are batch-fetched
   * by domain, then matched per-post by longest matching `uri` prefix. Posts
   * with no matching actor fall back to the deterministic domain placeholder
   * ({@link buildFederatedDomainAuthor}) so the displayName is NEVER blank.
   */
  private async buildFederatedAuthorMap(nodes: HydratedGraphNode[]): Promise<Map<string, PostActorSummary>> {
    const map = new Map<string, PostActorSummary>();

    // Collect orphaned federated posts (no Oxy author) and their origin domains.
    const orphans: Array<{ postId: string; activityId: string; domain: string }> = [];
    const domains = new Set<string>();
    for (const { post } of nodes) {
      if (post?.oxyUserId) continue;
      const federation = post?.federation as { activityId?: string; url?: string } | undefined;
      const source = federation?.activityId || federation?.url;
      if (!source || typeof source !== 'string') continue;
      let domain: string | undefined;
      try {
        domain = new URL(source).hostname || undefined;
      } catch {
        domain = undefined;
      }
      if (!domain) continue;
      const postId = this.resolveId(post);
      if (!postId) continue;
      orphans.push({ postId, activityId: source, domain });
      domains.add(domain);
    }

    if (orphans.length === 0) {
      return map;
    }

    // Batch-fetch every remote actor on the relevant domains, then match each
    // orphan to the actor whose `uri` is the LONGEST prefix of its activity URI.
    let actors: Array<{ uri: string; username: string; displayName?: string; avatarUrl?: string; domain: string; acct: string }> = [];
    try {
      actors = await FederatedActor.find(
        { domain: { $in: [...domains] } },
        { uri: 1, username: 1, displayName: 1, avatarUrl: 1, domain: 1, acct: 1 },
      ).lean();
    } catch (error) {
      logger.warn('[PostHydration] Failed to resolve federated actors for orphaned posts:', error);
      actors = [];
    }

    const actorsByDomain = new Map<string, typeof actors>();
    for (const actor of actors) {
      const list = actorsByDomain.get(actor.domain);
      if (list) list.push(actor);
      else actorsByDomain.set(actor.domain, [actor]);
    }

    for (const { postId, activityId, domain } of orphans) {
      const candidates = actorsByDomain.get(domain) ?? [];
      let best: typeof actors[number] | undefined;
      for (const actor of candidates) {
        if (activityId === actor.uri || activityId.startsWith(actor.uri + '/')) {
          if (!best || actor.uri.length > best.uri.length) best = actor;
        }
      }
      if (best) {
        const displayName = (typeof best.displayName === 'string' && best.displayName.trim()) || best.username || best.acct || domain;
        map.set(postId, {
          id: `federated:${best.uri}`,
          handle: best.acct || best.username || domain,
          displayName,
          avatarUrl: resolveAvatarUrl(best.avatarUrl),
          avatar: resolveAvatarUrl(best.avatarUrl),
          badges: undefined,
          isVerified: false,
          isFederated: true,
          instance: domain,
          actorUri: best.uri,
        });
      }
    }

    return map;
  }

  /**
   * Deterministic domain-only placeholder author for an orphaned FEDERATED post
   * whose remote {@link FederatedActor} could not be resolved. The origin domain
   * (from `activityId`/`url`) becomes the handle/display name and a stable
   * synthetic id — so the placeholder is consistent across requests, never
   * collides with a real Oxy id, and the displayName is NEVER blank. Returns
   * `undefined` when no domain can be derived, in which case the caller falls
   * back to a postId-scoped id.
   */
  private buildFederatedDomainAuthor(post: RawPost): PostActorSummary | undefined {
    const federation = post?.federation as { activityId?: string; url?: string } | undefined;
    const source = federation?.activityId || federation?.url;
    if (!source || typeof source !== 'string') return undefined;

    let domain: string | undefined;
    try {
      domain = new URL(source).hostname || undefined;
    } catch {
      // `activityId` is normally an absolute AP URI; if it is not parseable as a
      // URL we have no reliable domain, so fall through to the postId-scoped id.
      domain = undefined;
    }
    if (!domain) return undefined;

    return {
      id: `federated:${domain}`,
      handle: domain,
      displayName: domain,
      avatarUrl: undefined,
      avatar: undefined,
      badges: undefined,
      isVerified: false,
      isFederated: true,
      instance: domain,
    };
  }

  private extractReferenceIds(post: RawPost): string[] {
    const ids: string[] = [];
    const maybePush = (value: unknown) => {
      if (!value) return;
      if (typeof value === 'string') {
        ids.push(value);
        return;
      }
      if (typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const refId = obj._id ?? obj.id ?? obj.postId;
        if (refId) {
          ids.push(String(refId));
        }
      }
    };

    maybePush(post.boostOf);
    maybePush(post.quoteOf);
    if (post.originalPostId) {
      maybePush(post.originalPostId);
    }
    return ids.filter(Boolean);
  }

  private resolveId(post: RawPost): string {
    if (!post) return '';
    if (typeof post.id === 'string') return post.id;
    if (post._id) return String(post._id);
    return '';
  }

  private async populateViewerInteractions(postIds: string[], viewerContext: ViewerContext): Promise<void> {
    const viewerId = viewerContext.viewerId;
    if (!viewerId || postIds.length === 0) {
      return;
    }

    try {
      const [likes, bookmarks, boosts] = await Promise.all([
        Like.find({ userId: viewerId, postId: { $in: postIds } }).select('postId value').lean(),
        Bookmark.find({ userId: viewerId, postId: { $in: postIds } }).select('postId').lean(),
        Post.find({ oxyUserId: viewerId, boostOf: { $in: postIds } }).select('boostOf').lean(),
      ]);

      likes.forEach((like) => {
        const id = like?.postId ? String(like.postId) : undefined;
        if (!id) return;
        const value = like.value ?? 1;
        if (value === 1) {
          viewerContext.likedPosts.add(id);
        } else {
          viewerContext.downvotedPosts.add(id);
        }
      });

      bookmarks.forEach((bookmark) => {
        const id = bookmark?.postId ? String(bookmark.postId) : undefined;
        if (id) viewerContext.savedPosts.add(id);
      });

      boosts.forEach((boost) => {
        const id = boost?.boostOf ? String(boost.boostOf) : undefined;
        if (id) viewerContext.boostedPosts.add(id);
      });
    } catch (error) {
      logger.error('[PostHydration] Failed to populate viewer interactions:', error);
    }
  }

  private async buildPollMap(nodes: HydratedGraphNode[]): Promise<Map<string, Record<string, unknown>>> {
    const pollIds = Array.from(
      new Set(
        nodes
          .map(({ post }) => post?.content?.pollId)
          .filter(Boolean)
          .map((id) => String(id)),
      ),
    );

    if (pollIds.length === 0) {
      return new Map();
    }

    try {
      const polls = await Poll.find({ _id: { $in: pollIds } }).lean();
      const map = new Map<string, Record<string, unknown>>();

      polls.forEach((poll) => {
        const id = poll?._id ? String(poll._id) : undefined;
        if (!id) return;

        map.set(id, {
          question: poll.question,
          options: poll.options.map((opt) => opt.text),
          endTime: poll.endsAt?.toISOString?.() ?? poll.endsAt ?? new Date().toISOString(),
          votes: poll.options.reduce((acc: Record<string, number>, opt, index) => {
            acc[String(index)] = Array.isArray(opt.votes) ? opt.votes.length : 0;
            return acc;
          }, {}),
          userVotes: poll.options.reduce((acc: Record<string, string>, opt, index) => {
            if (Array.isArray(opt.votes)) {
              opt.votes.forEach((userId) => {
                if (userId) {
                  acc[String(userId)] = String(index);
                }
              });
            }
            return acc;
          }, {}),
        });
      });

      return map;
    } catch (error) {
      logger.error('[PostHydration] Failed to build poll map:', error);
      return new Map();
    }
  }

  private async buildUserMap(
    nodes: HydratedGraphNode[],
    extraLocalUserIds?: Set<string>,
  ): Promise<Map<string, PostActorSummary>> {
    const localUserIds = new Set<string>();

    for (const { post } of nodes) {
      if (post?.oxyUserId) {
        localUserIds.add(String(post.oxyUserId));
      }
    }

    // Merge in extra user IDs (e.g., replier IDs) for batch fetching
    if (extraLocalUserIds) {
      for (const id of extraLocalUserIds) {
        localUserIds.add(id);
      }
    }

    const resolved = await resolveUserSummaries([...localUserIds]);

    const userMap = new Map<string, PostActorSummary>();
    for (const [userId, value] of resolved) {
      userMap.set(userId, value.summary);
    }
    return userMap;
  }

  /**
   * Build the per-post link-preview map for a batch of posts.
   *
   * CRITICAL — this runs on the `/feed/*` response path and MUST NOT block on
   * remote network I/O. Resolving a link preview requires fetching the remote
   * HTML page (a multi-second round trip); doing that synchronously here caused
   * federated/external-link-heavy feeds to block for minutes when remote hosts
   * were slow or timed out.
   *
   * Strategy:
   *  - READ resolved previews from the Redis-backed {@link linkPreviewCache}
   *    under a hard time budget (no remote fetch, bounded).
   *  - Cache MISSES are warmed FIRE-AND-FORGET in the background (single-flight
   *    deduped per URL) so subsequent feed renders get the preview. The current
   *    response returns immediately with whatever was already cached.
   *
   * Net effect: the first time a URL appears it has no preview (warming in the
   * background); every subsequent render serves it instantly from cache.
   */
  private async buildLinkPreviewMap(nodes: HydratedGraphNode[]): Promise<Map<string, PostLinkPreview>> {
    const previewMap = new Map<string, PostLinkPreview>();

    const urlToPosts = new Map<string, string[]>(); // url -> [postId]

    // Only process top-level posts (depth 0) for link previews in feed
    // Nested posts (boosts/quotes) don't need link previews
    for (const { post } of nodes) {
      const postId = this.resolveId(post);
      if (!postId) continue;

      const text = post?.content?.text;
      if (!text || typeof text !== 'string') continue;

      const url = this.extractFirstUrl(text);
      if (!url) continue;

      if (!urlToPosts.has(url)) {
        urlToPosts.set(url, []);
      }
      urlToPosts.get(url)!.push(postId);
    }

    const uniqueUrls = Array.from(urlToPosts.keys());
    if (uniqueUrls.length === 0) return previewMap;

    // Read-only, bounded lookup of already-resolved previews. Never fetches.
    const { previews, toWarm } = await readPreviews(uniqueUrls);

    for (const [url, preview] of previews) {
      urlToPosts.get(url)?.forEach((postId) => previewMap.set(postId, preview));
    }

    // Warm cache misses in the background — does NOT gate this response.
    if (toWarm.length > 0) {
      this.warmLinkPreviews(toWarm);
    }

    return previewMap;
  }

  /**
   * Resolve link previews for the given URLs and write them to the cache.
   *
   * Runs entirely off the response path (fire-and-forget). De-duped per URL via
   * {@link linkPreviewWarmInflight} so concurrent feed requests don't fetch the
   * same remote page more than once, and capped concurrency so a burst of cold
   * URLs can't overwhelm outbound bandwidth. Failures are recorded as negative
   * cache markers so a dead/preview-less URL is not re-fetched every render.
   */
  private warmLinkPreviews(urls: string[]): void {
    const pending = urls.filter((url) => !linkPreviewWarmInflight.has(url));
    if (pending.length === 0) return;

    for (const url of pending) {
      linkPreviewWarmInflight.add(url);
    }

    void (async () => {
      const WARM_CONCURRENCY = 5;
      for (let i = 0; i < pending.length; i += WARM_CONCURRENCY) {
        const batch = pending.slice(i, i + WARM_CONCURRENCY);
        await Promise.all(
          batch.map(async (url) => {
            try {
              // This warm path runs detached, off the response path, so we can
              // AWAIT the image downscale and persist the OPTIMIZED CDN image
              // (not the raw full-res og:image) into the preview cache.
              const metadata = await linkMetadataService.fetchMetadata(url, { awaitImageCache: true });
              const hasContent = Boolean(
                metadata.title || metadata.description || metadata.image,
              );
              if (!hasContent) {
                await markNoPreview(url);
                return;
              }
              const preview: PostLinkPreview = {
                url: metadata.url,
                title: metadata.title || undefined,
                description: metadata.description || undefined,
                image: metadata.image || undefined,
                siteName: metadata.siteName || undefined,
              };
              await storePreview(url, preview);
            } catch (error) {
              // Mark as no-preview so we don't re-fetch a failing URL every render.
              await markNoPreview(url);
              logger.debug('[PostHydration] Background link-preview warm failed', {
                url,
                reason: error instanceof Error ? error.message : 'unknown',
              });
            } finally {
              linkPreviewWarmInflight.delete(url);
            }
          }),
        );
      }
    })().catch((error: unknown) => {
      // Defensive — the inner loop already swallows per-URL errors.
      logger.debug('[PostHydration] Link-preview warm batch failed', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      for (const url of pending) linkPreviewWarmInflight.delete(url);
    });
  }

  private extractFirstUrl(text: string): string | null {
    if (!text) return null;
    const urlPattern = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
    let match: RegExpExecArray | null;
    while ((match = urlPattern.exec(text)) !== null) {
      if (!match[0]) continue;
      let url = match[0];
      while (/[.,!?):;\]]$/.test(url)) {
        url = url.slice(0, -1);
      }
      if (!/^https?:\/\//i.test(url)) {
        url = `https://${url}`;
      }
      try {
        new URL(url);
        return url;
      } catch {
        continue;
      }
    }
    return null;
  }

  private async buildAuthorPrivacyMap(
    nodes: HydratedGraphNode[],
    viewerContext?: ViewerContext,
  ): Promise<Map<string, typeof DEFAULT_PRIVACY>> {
    // Use pre-fetched cache from buildViewerContext if available
    const cached = (viewerContext as ExtendedViewerContext)?._authorPrivacyCache;
    if (cached && cached.size > 0) {
      // Ensure all authors in current nodes are covered (some may be from depth>0 fetches)
      const authorIds = Array.from(
        new Set(nodes.map(({ post }) => post?.oxyUserId).filter(Boolean).map((id) => String(id))),
      );
      const missingIds = authorIds.filter((id) => !cached.has(id));
      if (missingIds.length === 0) {
        return cached;
      }

      // Fetch only missing authors
      try {
        const settings = await UserSettings.find({ oxyUserId: { $in: missingIds } }).lean();
        for (const setting of settings) {
          const authorId = String(setting.oxyUserId);
          cached.set(authorId, {
            hideLikeCounts: Boolean(setting.privacy?.hideLikeCounts),
            hideShareCounts: Boolean(setting.privacy?.hideShareCounts),
            hideReplyCounts: Boolean(setting.privacy?.hideReplyCounts),
            hideSaveCounts: Boolean(setting.privacy?.hideSaveCounts),
          });
        }
        for (const id of missingIds) {
          if (!cached.has(id)) cached.set(id, { ...DEFAULT_PRIVACY });
        }
      } catch (error) {
        logger.warn('[PostHydration] Failed to load missing author privacy settings:', error);
        for (const id of missingIds) cached.set(id, { ...DEFAULT_PRIVACY });
      }
      return cached;
    }

    // Fallback: no cache available, fetch all
    const authorIds = Array.from(
      new Set(nodes.map(({ post }) => post?.oxyUserId).filter(Boolean).map((id) => String(id))),
    );

    const privacyMap = new Map<string, typeof DEFAULT_PRIVACY>();
    if (authorIds.length === 0) {
      return privacyMap;
    }

    try {
      const settings = await UserSettings.find({ oxyUserId: { $in: authorIds } }).lean();
      settings.forEach((setting) => {
        const authorId = String(setting.oxyUserId);
        privacyMap.set(authorId, {
          hideLikeCounts: Boolean(setting.privacy?.hideLikeCounts),
          hideShareCounts: Boolean(setting.privacy?.hideShareCounts),
          hideReplyCounts: Boolean(setting.privacy?.hideReplyCounts),
          hideSaveCounts: Boolean(setting.privacy?.hideSaveCounts),
        });
      });

      authorIds.forEach((authorId) => {
        if (!privacyMap.has(authorId)) {
          privacyMap.set(authorId, { ...DEFAULT_PRIVACY });
        }
      });
    } catch (error) {
      logger.warn('[PostHydration] Failed to load author privacy settings:', error);
      authorIds.forEach((authorId) => {
        privacyMap.set(authorId, { ...DEFAULT_PRIVACY });
      });
    }

    return privacyMap;
  }

  /**
   * Phase 1: Aggregate replier user IDs without fetching their profiles.
   * Returns both per-post replier arrays and a flat set of all IDs.
   */
  private async aggregateRecentReplierIds(postIds: string[]): Promise<{
    perPostRepliers: Map<string, string[]>;
    allReplierIds: Set<string>;
  }> {
    const perPostRepliers = new Map<string, string[]>();
    const allReplierIds = new Set<string>();

    if (postIds.length === 0) return { perPostRepliers, allReplierIds };

    try {
      const objectIds = postIds.map((id) => {
        try { return new mongoose.Types.ObjectId(id); } catch { return id; }
      });

      // Use $push (preserves $sort order) then deduplicate via $reduce
      const recentReplies = await Post.aggregate([
        { $match: { parentPostId: { $in: objectIds } } },
        { $sort: { createdAt: -1 } },
        { $group: {
          _id: '$parentPostId',
          replierIds: { $push: '$oxyUserId' },
        }},
        { $project: {
          _id: 1,
          // Deduplicate while preserving recency order, then take first 3
          replierIds: {
            $slice: [
              { $reduce: {
                input: '$replierIds',
                initialValue: [],
                in: { $cond: [
                  { $in: ['$$this', '$$value'] },
                  '$$value',
                  { $concatArrays: ['$$value', ['$$this']] },
                ]},
              }},
              3,
            ],
          },
        }},
      ]);

      for (const entry of recentReplies) {
        const parentId = String(entry._id);
        const ids = (entry.replierIds as unknown[] || []).map((id) => String(id));
        perPostRepliers.set(parentId, ids);
        for (const id of ids) {
          allReplierIds.add(id);
        }
      }
    } catch (error) {
      logger.warn('[PostHydration] Failed to aggregate replier IDs:', error);
    }

    return { perPostRepliers, allReplierIds };
  }

  /**
   * Phase 2: Build replier avatar map using the already-populated userMap.
   * No additional user profile fetches needed.
   */
  private buildReplierAvatarsFromUserMap(
    perPostRepliers: Map<string, string[]>,
    userMap: Map<string, PostActorSummary>,
  ): Map<string, string[]> {
    const replierMap = new Map<string, string[]>();

    for (const [parentId, replierIds] of perPostRepliers) {
      const avatars: string[] = [];
      for (const replierId of replierIds) {
        const user = userMap.get(replierId);
        if (user?.avatar) {
          avatars.push(user.avatar);
        }
      }
      if (avatars.length > 0) {
        replierMap.set(parentId, avatars);
      }
    }

    return replierMap;
  }

  private canViewerReadPost(
    post: RawPost,
    authorId: string,
    viewerContext: ViewerContext,
    isFederatedPost: boolean,
  ): boolean {
    const isOwner = Boolean(viewerContext.viewerId && viewerContext.viewerId === authorId);
    if (isOwner) {
      return true;
    }

    // Federated posts are imported only from public ActivityPub objects. Some
    // older imported rows may not have a local status/visibility stamp, so keep
    // them renderable unless they explicitly carry a non-public local state.
    if (isFederatedPost) {
      const status = post.status ? String(post.status) : 'published';
      const visibility = post.visibility ? String(post.visibility) : PostVisibility.PUBLIC;
      return status === 'published' && visibility === PostVisibility.PUBLIC;
    }

    const status = post.status ? String(post.status) : 'published';
    if (status !== 'published') {
      return false;
    }

    const visibility = (post.visibility ?? PostVisibility.PUBLIC) as string;
    if (visibility === PostVisibility.PUBLIC) {
      return true;
    }

    if (visibility === PostVisibility.FOLLOWERS_ONLY) {
      return Boolean(viewerContext.viewerId && viewerContext.follows.has(authorId));
    }

    return false;
  }

  private async buildPostSummary(params: {
    post: RawPost;
    viewerContext: ViewerContext;
    pollMap: Map<string, Record<string, unknown>>;
    userMap: Map<string, PostActorSummary>;
    mentionCache: Map<string, PostActorSummary>;
    linkPreviewMap: Map<string, PostLinkPreview>;
    authorPrivacyMap: Map<string, typeof DEFAULT_PRIVACY>;
    recentReplierMap?: Map<string, string[]>;
    federatedAuthorMap?: Map<string, PostActorSummary>;
  }): Promise<HydratedPostSummary | null> {
    const { post, viewerContext, pollMap, userMap, mentionCache, linkPreviewMap, authorPrivacyMap, recentReplierMap, federatedAuthorMap } = params;

    const postId = this.resolveId(post);
    if (!postId) return null;

    const isFederatedPost = !!post?.federation;
    const resolvedAuthorId = post?.oxyUserId ? String(post.oxyUserId) : undefined;

    // A federated post whose author actor was never linked to an Oxy user
    // (orphaned `oxyUserId`) STILL physically exists and is public — it must
    // render rather than vanish (e.g. a boost of such a post would otherwise
    // surface as a blank row). Derive a stable placeholder author from its
    // federation metadata so the post is renderable. A NON-federated post with
    // no author is a genuine data error and is still dropped.
    if (!resolvedAuthorId && !isFederatedPost) return null;

    // `authorId` keys privacy/viewer-state/permission lookups below. For an
    // orphaned federated post we prefer the resolved REMOTE actor (real
    // displayName + remote avatarUrl) and fall back to a deterministic synthetic
    // id derived from its origin domain so those lookups behave (the viewer never
    // owns/blocks a synthetic id) without a real Oxy id. The displayName is never
    // blank in either branch.
    const federatedFallback = !resolvedAuthorId
      ? (federatedAuthorMap?.get(postId) ?? this.buildFederatedDomainAuthor(post))
      : undefined;
    const authorId = resolvedAuthorId ?? federatedFallback?.id ?? `federated:${postId}`;

    // Never hydrate content that the current viewer is not allowed to read.
    // This is especially important for nested boost/quote references, which are
    // fetched by id during hydration and may be attached to otherwise-public
    // payloads.
    if (!this.canViewerReadPost(post, authorId, viewerContext, isFederatedPost)) {
      return null;
    }

    // Privacy checks only apply to local users (federated posts are public by definition)
    if (!isFederatedPost) {
      if (viewerContext.restrictedIds.has(authorId) && viewerContext.viewerId !== authorId) {
        return null;
      }

      // Filter posts from private/followers_only profiles
      // Own posts are always visible; public profiles pass through
      if (viewerContext.privateProfileIds.has(authorId) && viewerContext.viewerId !== authorId) {
        // If not authenticated, hide private profiles
        if (!viewerContext.viewerId) return null;
        // If viewer doesn't follow the author, hide the post
        if (!viewerContext.follows.has(authorId)) return null;
      }
    }

    const user = userMap.get(authorId) ?? federatedFallback ?? {
      id: authorId,
      handle: authorId,
      displayName: authorId,
      avatarUrl: undefined,
      avatar: undefined,
      badges: undefined,
      isVerified: false,
    };

    const content = this.buildContent(post, pollMap, params.viewerContext);
    const attachments = this.buildAttachments(post, pollMap);
    const linkPreview = linkPreviewMap.get(postId) ?? null;
    const viewerState = this.buildViewerState(postId, authorId, viewerContext);
    const permissions = this.buildPermissions(post, authorId, viewerContext);
    const authorPrivacy = authorPrivacyMap.get(authorId) ?? { ...DEFAULT_PRIVACY };
    const replierAvatars = recentReplierMap?.get(postId);
    const engagement = this.buildEngagement(post, authorPrivacy, replierAvatars);

    // Only include essential metadata for feed performance
    const includeFullMetadata = (params.viewerContext as ExtendedViewerContext).includeFullMetadata !== false;
    const metadata = {
      visibility: (post.visibility ?? PostVisibility.PUBLIC) as PostVisibility,
      replyPermission: post.replyPermission as import('@mention/shared-types').ReplyPermission[] | undefined,
      reviewReplies: Boolean(post.reviewReplies),
      quotesDisabled: Boolean(post.quotesDisabled),
      isPinned: Boolean(post.metadata?.isPinned),
      isSensitive: Boolean(post.metadata?.isSensitive),
      isThread: Boolean(post.threadId),
      language: post.language || undefined,
      // Only include tags/hashtags if needed (can be large arrays)
      tags: includeFullMetadata && Array.isArray(post.tags) && post.tags.length > 0 ? post.tags : undefined,
      mentions: includeFullMetadata && Array.isArray(post.mentions) && post.mentions.length > 0 ? post.mentions.filter((m): m is string => typeof m === 'string') : undefined,
      hashtags: includeFullMetadata && Array.isArray(post.hashtags) && post.hashtags.length > 0 ? post.hashtags : undefined,
      createdAt: new Date((post.createdAt || post.date || Date.now()) as string | number | Date).toISOString(),
      updatedAt: new Date((post.updatedAt || post.createdAt || Date.now()) as string | number | Date).toISOString(),
      status: post.status as 'draft' | 'published' | 'scheduled' | undefined,
    };

    // Always replace mentions in text if they exist, regardless of includeFullMetadata
    // This ensures mentions are always displayed correctly
    let finalText = typeof content?.text === 'string' ? content.text : '';
    const postMentions: string[] = Array.isArray(post.mentions) && post.mentions.length > 0 ? (post.mentions as string[]) : [];
    if (postMentions.length > 0 && finalText.includes('[mention:')) {
      finalText = await this.replaceMentionPlaceholders(
        finalText,
        postMentions,
        mentionCache,
      );
    }

    if (content) {
      content.text = finalText;
    }

    return {
      id: postId,
      content: content ?? { text: finalText },
      attachments,
      linkPreview,
      user,
      engagement,
      viewerState,
      permissions,
      metadata,
      // Include parentPostId for thread hierarchy in replies
      ...(post.parentPostId ? { parentPostId: String(post.parentPostId) } : {}),
    };
  }

  /**
   * Normalize a raw `content.media` array (strings or objects from lean docs)
   * into typed {@link MediaItem}s carrying only `id`/`type`. URL resolution is
   * applied separately via {@link resolveMediaItems}.
   */
  private normalizeMediaItems(rawMedia: unknown): import('@mention/shared-types').MediaItem[] | undefined {
    if (!Array.isArray(rawMedia)) {
      return undefined;
    }
    const items = rawMedia
      .map((item: unknown): import('@mention/shared-types').MediaItem | undefined => {
        if (!item) return undefined;
        if (typeof item === 'string') {
          return { id: item, type: 'image' };
        }
        if (typeof item === 'object') {
          const obj = item as Record<string, unknown>;
          if (obj.id) {
            return {
              id: String(obj.id),
              type: obj.type === 'video' || obj.type === 'gif' ? (obj.type as 'video' | 'gif') : 'image',
            };
          }
        }
        return undefined;
      })
      .filter((x): x is import('@mention/shared-types').MediaItem => x !== undefined);
    return items;
  }

  private buildContent(post: RawPost, pollMap: Map<string, Record<string, unknown>>, viewerContext?: ViewerContext): Record<string, unknown> {
    const baseContent = post?.content ?? {};

    const normalizedMedia = this.normalizeMediaItems(baseContent.media);
    const media = normalizedMedia ? resolveMediaItems(normalizedMedia) : undefined;

    const pollId = baseContent.pollId;
    const poll = pollId ? pollMap.get(String(pollId)) : undefined;

    return {
      text: typeof baseContent.text === 'string' ? baseContent.text : '',
      media,
      poll,
      pollId: pollId ? String(pollId) : undefined,
      // For feed, only include article metadata, not full body (saves bandwidth)
      article: baseContent.article
        ? {
            articleId: baseContent.article.articleId,
            title: baseContent.article.title,
            excerpt: baseContent.article.excerpt,
            // Only include body if explicitly requested (e.g., for detail view)
            ...((viewerContext as ExtendedViewerContext)?.includeFullArticleBody && baseContent.article.body
              ? { body: baseContent.article.body }
              : {}),
          }
        : undefined,
      sources: Array.isArray(baseContent.sources) ? baseContent.sources : undefined,
      location: baseContent.location,
      event: baseContent.event,
      room: baseContent.room ?? baseContent.space,
      attachments: Array.isArray(baseContent.attachments) ? baseContent.attachments : undefined,
    };
  }

  private buildAttachments(post: RawPost, pollMap: Map<string, Record<string, unknown>>): PostAttachmentBundle {
    const content = post?.content ?? {};
    const attachments: PostAttachmentBundle = {};

    const normalizedMedia = this.normalizeMediaItems(content.media);
    if (normalizedMedia && normalizedMedia.length > 0) {
      attachments.media = resolveMediaItems(normalizedMedia);
    }

    const pollId = content.pollId;
    if (pollId) {
      const poll = pollMap.get(String(pollId));
      if (poll) {
        attachments.poll = poll as unknown as import('@mention/shared-types').PollData;
      }
    } else if (content.poll) {
      attachments.poll = content.poll;
    }

    if (content.article) {
      attachments.article = {
        articleId: content.article.articleId,
        title: content.article.title,
        body: content.article.body,
        excerpt: content.article.excerpt,
      };
    }

    if (Array.isArray(content.sources) && content.sources.length > 0) {
      attachments.sources = (content.sources as Array<{ url: string; title?: string }>).map((source: { url: string; title?: string }) => ({
        url: source.url,
        title: source.title,
      }));
    }

    if (content.location?.coordinates?.length === 2) {
      attachments.location = content.location;
    }

    if (content.event) {
      attachments.event = {
        eventId: content.event.eventId,
        name: content.event.name,
        date: content.event.date,
        location: content.event.location,
        description: content.event.description,
      };
    }

    const roomData = content.room ?? content.space;
    if (roomData) {
      attachments.room = {
        roomId: roomData.roomId,
        title: roomData.title,
        status: roomData.status,
        topic: roomData.topic,
        host: roomData.host,
      };
    }

    return attachments;
  }

  private buildViewerState(postId: string, authorId: string, viewerContext: ViewerContext): PostViewerState {
    const isOwner = viewerContext.viewerId === authorId;

    return {
      isOwner,
      isLiked: viewerContext.likedPosts.has(postId),
      isDownvoted: viewerContext.downvotedPosts.has(postId),
      isBoosted: viewerContext.boostedPosts.has(postId),
      isSaved: viewerContext.savedPosts.has(postId),
    };
  }

  private buildPermissions(post: RawPost, authorId: string, viewerContext: ViewerContext): PostPermissions {
    const isOwner = viewerContext.viewerId === authorId;
    const canReply = this.computeReplyPermission(post, authorId, viewerContext);

    return {
      canReply,
      canDelete: isOwner,
      canPin: isOwner,
      canViewSources: Boolean(post?.content?.sources?.length),
      canEdit: isOwner,
    };
  }

  private computeReplyPermission(post: RawPost, authorId: string, viewerContext: ViewerContext): boolean {
    const viewerId = viewerContext.viewerId;
    if (!viewerId) return false;
    if (viewerId === authorId) return true;

    const permissions: string[] = post?.replyPermission || ['anyone'];

    if (permissions.includes('anyone')) return true;
    if (permissions.includes('nobody')) return false;

    for (const perm of permissions) {
      switch (perm) {
        case 'followers':
          if (viewerContext.follows.has(authorId)) return true;
          break;
        case 'following':
          if (viewerContext.followedBy.has(authorId)) return true;
          break;
        case 'mentioned':
          if (Array.isArray(post?.mentions) && post.mentions.some((mention: unknown) => {
            const mentionId = typeof mention === 'string' ? mention : typeof mention === 'object' && mention ? String((mention as Record<string, unknown>).id || (mention as Record<string, unknown>)._id || (mention as Record<string, unknown>).oxyUserId || '') : '';
            return mentionId && String(mentionId) === viewerId;
          })) return true;
          break;
      }
    }

    return false;
  }

  private buildEngagement(
    post: RawPost,
    authorPrivacy: typeof DEFAULT_PRIVACY,
    recentReplierAvatars?: string[],
  ): PostEngagementSummary {
    const stats = post?.stats || {};
    const metadata = post?.metadata || {};

    const likesCount = typeof stats.likesCount === 'number' ? stats.likesCount : 0;
    const downvotesCount = typeof stats.downvotesCount === 'number' ? stats.downvotesCount : 0;
    const boostsCount = typeof stats.boostsCount === 'number' ? stats.boostsCount : 0;
    const repliesCount = typeof stats.commentsCount === 'number' ? stats.commentsCount : 0;
    const savesCount = Array.isArray(metadata.savedBy) ? metadata.savedBy.length : undefined;

    const viewsCount = typeof stats.viewsCount === 'number' ? stats.viewsCount : 0;

    return {
      likes: authorPrivacy.hideLikeCounts ? null : likesCount,
      downvotes: authorPrivacy.hideLikeCounts ? null : downvotesCount,
      boosts: authorPrivacy.hideShareCounts ? null : boostsCount,
      replies: authorPrivacy.hideReplyCounts ? null : repliesCount,
      saves: authorPrivacy.hideSaveCounts ? null : savesCount ?? null,
      views: viewsCount > 0 ? viewsCount : null,
      impressions: null,
      recentReplierAvatars: recentReplierAvatars?.length ? recentReplierAvatars : undefined,
    };
  }

  private attachNestedContext(
    post: RawPost,
    summary: HydratedPostSummary,
    summaryMap: Map<string, HydratedPostSummary>,
    viewerContext: ViewerContext,
  ): HydratedPost | null {
    const postId = summary.id;
    const boostOf = post?.boostOf ? String(post.boostOf) : undefined;
    const quoteOf = post?.quoteOf ? String(post.quoteOf) : undefined;

    let originalPost: HydratedPostSummary | null = null;
    if (boostOf) {
      originalPost = summaryMap.get(boostOf) ?? null;
    } else if (quoteOf) {
      originalPost = summaryMap.get(quoteOf) ?? null;
    }

    const quotedPost = quoteOf ? summaryMap.get(quoteOf) ?? null : null;
    const boostOriginal = boostOf ? summaryMap.get(boostOf) ?? null : null;
    const boostContext: HydratedBoostContext | null = boostOf && boostOriginal
      ? {
          originalPost: boostOriginal,
          actor: summary.user,
        }
      : null;

    const context = this.buildContext(post);

    return {
      ...summary,
      originalPost,
      quotedPost,
      boost: boostContext,
      context,
    };
  }

  private buildContext(post: RawPost) {
    if (!post?.threadId && !post?.parentPostId) {
      return undefined;
    }

    return {
      parentThreadId: post.threadId ? String(post.threadId) : undefined,
      isThreadParent: !post.parentPostId && Boolean(post.threadId),
    };
  }

  private async replaceMentionPlaceholders(
    text: string,
    mentions: string[],
    mentionCache: Map<string, PostActorSummary>,
  ): Promise<string> {
    if (!text || !Array.isArray(mentions) || mentions.length === 0) {
      return text;
    }

    // Normalize mention IDs and collect those whose placeholder is present in
    // the text but not yet in the per-request cache. Only placeholders that
    // actually appear are worth resolving.
    const uncachedIds: string[] = [];
    for (const mentionIdRaw of mentions) {
      let mentionId: string;
      if (typeof mentionIdRaw === 'string') {
        mentionId = mentionIdRaw;
      } else if (mentionIdRaw && typeof mentionIdRaw === 'object') {
        const raw = mentionIdRaw as Record<string, unknown>;
        mentionId = String(raw?.id || raw?._id || raw || '');
      } else {
        mentionId = String(mentionIdRaw || '');
      }
      if (mentionId && text.includes(`[mention:${mentionId}]`) && !mentionCache.has(mentionId)) {
        uncachedIds.push(mentionId);
      }
    }

    // Resolve the uncached ids through the shared user-summary resolver: ONE
    // batched Redis read + ONE bulk service-token Oxy fetch for the misses, and
    // it writes the resolved summaries back to the Redis cache. A user who is
    // both a post author and a mention is already warm from `buildUserMap`, so
    // this never re-fetches them. Ids that only resolve to a fallback summary
    // (handle === displayName === id, i.e. the lookup failed) are treated as
    // unresolved and left as the original placeholder.
    if (uncachedIds.length > 0) {
      const resolved = await resolveUserSummaries(uncachedIds);
      for (const mentionId of uncachedIds) {
        const value = resolved.get(mentionId);
        if (!value || isFallbackUserSummary(mentionId, value.summary)) {
          continue;
        }
        mentionCache.set(mentionId, value.summary);
      }
    }

    // Single-pass replacement: build the placeholder→replacement map, then run
    // ONE regex over the text. An unresolved mention (absent from the map) is
    // left as its original placeholder.
    const replacements = new Map<string, string>();
    for (const [mentionId, mentionUser] of mentionCache) {
      replacements.set(mentionId, `[@${mentionUser.displayName}](${mentionUser.handle})`);
    }

    return text.replace(/\[mention:([^\]]+)\]/g, (placeholder, mentionId: string) => {
      return replacements.get(mentionId) ?? placeholder;
    });
  }
}

export const postHydrationService = new PostHydrationService();
