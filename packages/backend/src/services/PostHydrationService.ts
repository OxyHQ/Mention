import { FeedPostSlice, FeedSliceItem, HydratedPost, HydratedPostSummary, HydratedBoostContext, HydratedAuthor, PostActorSummary, PostAttachmentBundle, PostEngagementSummary, PostLinkPreview, PostPermissions, PostViewerState, PostVisibility, PostAuthorshipEntry } from '@mention/shared-types';
import mongoose from 'mongoose';
import { Post } from '../models/Post';
import Poll from '../models/Poll';
import Like from '../models/Like';
import Bookmark from '../models/Bookmark';
import { FederatedActor } from '../models/FederatedActor';
import { UserSettings } from '../models/UserSettings';
import { oxy as defaultOxyClient } from '../../server';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { getBlockedUserIds, getRestrictedUserIds, extractFollowingIds, extractFollowersIds, OxyClient } from '../utils/privacyHelpers';
import { resolveAvatarUrl, resolveMediaItems } from '../utils/mediaResolver';
import { logger } from '../utils/logger';
import type { User as OxyUser } from '@oxyhq/core';
import type { LinkPreview } from '@oxyhq/contracts';
import { assignThreadState } from './ThreadSlicingService';
import { mget as mgetUserSummaries, mset as msetUserSummaries, CachedUserSummary } from './userSummaryCache';
import {
  collectAuthorshipUserIds,
  getHeaderAuthorshipEntries,
  getViewerEntry,
  normalizeAuthorship,
} from '../utils/postAuthorship';

import { PostContent, PostMetadata } from '@mention/shared-types';

/**
 * A raw post plain-object as returned by `.lean()` or `.toObject()`.
 * Covers all fields accessed during hydration, including federated-only fields.
 */
interface RawPost {
  _id?: unknown;
  id?: string;
  oxyUserId?: string;
  authorship?: PostAuthorshipEntry[];
  content?: Partial<PostContent>;
  metadata?: Partial<PostMetadata>;
  /**
   * Stage-A classification subdoc. Only the canonical multi-language array is
   * read during hydration (surfaced to the DTO as `metadata.languages`).
   */
  postClassification?: { languages?: string[] };
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
  /**
   * When hydrating posts for public federation surfaces, referenced posts
   * (boost/quote originals) must not bypass their own publication controls.
   * Root posts are still supplied by the caller's query; this only constrains
   * graph expansion by id.
   */
  publicReferencesOnly?: boolean;
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
 * Build the ready-to-render {@link CachedUserSummary} (author summary + follower
 * count) from a raw Oxy user. Centralized so the per-id fallback path and the
 * bulk path produce IDENTICAL output, and so the same shape is what we cache.
 */
function summaryFromOxyUser(userId: string, userData: OxyUser): CachedUserSummary {
  const username: string = String(userData?.username || userData?.handle || userId);
  // May be absent — the renderer falls back to the (always-present) handle. Do
  // NOT synthesize a name from the handle here; the handle fallback lives once,
  // client-side, on `PostActorSummary.handle`.
  const displayName: string | undefined = userData.name?.displayName;
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

/**
 * The clearly-degraded actor summary emitted when an author cannot be resolved
 * from Oxy (a transient bulk + per-id fetch failure). It carries an EMPTY handle
 * ON PURPOSE: every renderer gates the `@handle` line and the `/@handle` profile
 * link on a non-empty handle, so a momentarily-unresolvable author shows a
 * neutral "Unknown user" with no tappable handle rather than rendering its raw
 * Oxy id as a fake username (the ghost-handle bug). This summary is NEVER written
 * to the Redis user-summary cache (see {@link resolveUserSummaries}), so the next
 * hydration re-resolves the real user and the DTO self-heals.
 */
export function degradedActorSummary(userId: string): PostActorSummary {
  return {
    id: userId,
    handle: '',
    displayName: 'Unknown user',
    avatarUrl: undefined,
    badges: undefined,
    isVerified: false,
  };
}

/** A minimal, safe summary used when an author cannot be resolved from Oxy. */
function fallbackSummary(userId: string): CachedUserSummary {
  return { summary: degradedActorSummary(userId) };
}

/**
 * Whether a summary is the {@link degradedActorSummary} produced when a user
 * could not be resolved from Oxy. The degraded summary is the ONLY summary with
 * an empty handle — a resolved Oxy user always has a non-empty handle (the
 * `username → handle → id` fallback in {@link summaryFromOxyUser}). Callers use
 * this to SKIP an unresolved actor (starter-pack members, mention-placeholder
 * replacement) instead of rendering a nameless row. Kept in lockstep with
 * `degradedActorSummary`.
 */
export function isFallbackUserSummary(summary: PostActorSummary): boolean {
  return summary.handle === '';
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

/**
 * Repair FEDERATED author summaries that degraded to {@link degradedActorSummary}
 * (empty handle, "Unknown user") because Oxy resolution failed transiently.
 *
 * Unlike a local author, a federated author's canonical `username@domain` is
 * knowable WITHOUT Oxy: Mention's own {@link FederatedActor} record carries
 * `acct`. Repairing from it lets a federated post show its REAL, tappable handle
 * (`/@username@domain` → WebFinger-resolved profile) instead of a neutral
 * "Unknown user" whenever Oxy is momentarily unreachable (or in the brief window
 * right after the federation bridge creates the Oxy user).
 *
 * Mutates `summaries` in place. Batched (a single query), scoped to the ids that
 * actually degraded, and best-effort — a lookup failure leaves the degraded
 * summary untouched rather than failing hydration. Shared by feed hydration
 * ({@link PostHydrationService.buildUserMap}) and reply-context author
 * resolution ({@link ThreadSlicingService}).
 */
export async function repairFederatedFallbackSummaries(
  summaries: Map<string, PostActorSummary>,
  federatedAuthorIds: Set<string>,
): Promise<void> {
  const needsRepair: string[] = [];
  for (const authorId of federatedAuthorIds) {
    const summary = summaries.get(authorId);
    // The degraded summary has an empty handle; `handle === authorId` guards any
    // legacy raw-id summary. Either is the placeholder we want to replace.
    if (!summary || isFallbackUserSummary(summary) || summary.handle === authorId) {
      needsRepair.push(authorId);
    }
  }
  if (needsRepair.length === 0) return;

  let actors: Array<{ oxyUserId?: string; acct?: string; username?: string; domain?: string; name?: string }>;
  try {
    actors = await FederatedActor.find({ oxyUserId: { $in: needsRepair } })
      .select('oxyUserId acct username domain name')
      .lean();
  } catch (error) {
    logger.warn('[PostHydration] Federated author repair lookup failed', {
      count: needsRepair.length,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return;
  }

  for (const actor of actors) {
    const oxyUserId = actor.oxyUserId ? String(actor.oxyUserId) : '';
    if (!oxyUserId) continue;
    const handle = actor.acct
      || (actor.username && actor.domain ? `${actor.username}@${actor.domain}` : '');
    if (!handle) continue;
    const existing = summaries.get(oxyUserId);
    summaries.set(oxyUserId, {
      id: oxyUserId,
      handle,
      // Prefer the federated actor's own display name; leave undefined (never the
      // raw id / "Unknown user") so the renderer falls back to the real handle.
      displayName: actor.name?.trim() || undefined,
      avatarUrl: existing?.avatarUrl,
      isVerified: existing?.isVerified ?? false,
      isFederated: true,
      instance: actor.domain || undefined,
    });
  }
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

    const graph = await this.collectPostsWithDepth(
      initialPosts,
      maxDepth,
      viewerContext.blockedIds,
      options.publicReferencesOnly === true,
    );

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
    publicReferencesOnly: boolean,
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
      const referenceQuery: Record<string, unknown> = { _id: { $in: nextIds } };
      if (publicReferencesOnly) {
        referenceQuery.status = 'published';
        referenceQuery.visibility = PostVisibility.PUBLIC;
      }

      try {
        const fetched = await Post.find(referenceQuery)
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
      for (const userId of collectAuthorshipUserIds(post?.authorship)) {
        localUserIds.add(userId);
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

    // A FEDERATED author whose Oxy resolution degraded (empty handle, "Unknown
    // user") still has a knowable canonical handle in Mention's own
    // FederatedActor record. Repair those so a federated post shows its real
    // `@username@domain` (tappable) instead of a neutral "Unknown user".
    const federatedAuthorIds = new Set<string>();
    for (const { post } of nodes) {
      if (post?.federation && post?.oxyUserId) {
        federatedAuthorIds.add(String(post.oxyUserId));
      }
    }
    await repairFederatedFallbackSummaries(userMap, federatedAuthorIds);

    return userMap;
  }

  /**
   * Build the per-post link-preview map for a batch of posts.
   *
   * Link previews are resolved through the Oxy ecosystem link-preview service
   * ({@link OxyServices.getLinkPreviews}) instead of being scraped locally. Oxy
   * owns BOTH resolution and privacy-preserving image hosting: the `image` /
   * `favicon` on every returned preview is an absolute Oxy-hosted
   * (`cloud.oxy.so`) URL, so it is passed through to the post DTO unchanged —
   * never re-proxied via `/media/proxy`.
   *
   * This stays safe on the `/feed/*` response path: the batch call is a fast
   * cached read (mirroring the {@link OxyServices.getUsersByIds} author-batch
   * call also awaited here). Oxy returns already-resolved previews immediately
   * and a `'pending'` placeholder for any first-seen URL, which it warms
   * server-side in the background — it does NOT block on a remote HTML fetch.
   * A `'pending'`/`'empty'` result is omitted, so (exactly as before) a brand-new
   * URL shows no preview on its first render and gains one on a later render once
   * Oxy has resolved it. Only top-level posts carry previewable text; nested
   * boosts/quotes have no preview of their own.
   */
  private async buildLinkPreviewMap(nodes: HydratedGraphNode[]): Promise<Map<string, PostLinkPreview>> {
    const previewMap = new Map<string, PostLinkPreview>();

    const urlToPosts = new Map<string, string[]>(); // url -> [postId]

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

    let previews: Record<string, LinkPreview>;
    try {
      previews = await getServiceOxyClient().getLinkPreviews(uniqueUrls);
    } catch (error) {
      // Best-effort: a preview-service hiccup must never fail feed hydration.
      logger.warn('[PostHydration] Failed to resolve link previews from Oxy', {
        count: uniqueUrls.length,
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return previewMap;
    }

    for (const [url, postIds] of urlToPosts) {
      const preview = previews[url];
      // Only fully-resolved previews are rendered; `'pending'`/`'empty'` are
      // omitted so the URL re-resolves into a real preview on a later render.
      if (!preview || preview.status !== 'resolved') continue;

      const mapped: PostLinkPreview = {
        url: preview.url,
        title: preview.title || undefined,
        description: preview.description || undefined,
        // Already an absolute Oxy-hosted `cloud.oxy.so` URL — render directly.
        image: preview.image || undefined,
        siteName: preview.siteName || undefined,
      };

      for (const postId of postIds) {
        previewMap.set(postId, mapped);
      }
    }

    return previewMap;
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
        if (user?.avatarUrl) {
          avatars.push(user.avatarUrl);
        }
      }
      if (avatars.length > 0) {
        replierMap.set(parentId, avatars);
      }
    }

    return replierMap;
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
  }): Promise<HydratedPostSummary | null> {
    const { post, viewerContext, pollMap, userMap, mentionCache, linkPreviewMap, authorPrivacyMap, recentReplierMap } = params;

    const postId = this.resolveId(post);
    if (!postId) return null;

    const isFederatedPost = !!post?.federation;

    // Every post — federated or native — now carries a mandatory `oxyUserId`:
    // the federated-actor → Oxy user link is enforced at ingest, so orphaned
    // federated posts no longer exist. A post with no author is a genuine data
    // error and is dropped. The author always renders through the canonical Oxy
    // `name.displayName` path (buildUserMap / resolveUserSummaries).
    const authorId = post?.oxyUserId ? String(post.oxyUserId) : undefined;
    if (!authorId) return null;

    const authorship = normalizeAuthorship(post.authorship as PostAuthorshipEntry[] | undefined);

    // Privacy checks only apply to local users (federated posts are public by definition).
    // Hydration can be used for globally-broadcast DTOs and for nested quote/boost
    // references fetched by id, so enforce post-level ACL here instead of relying
    // on callers to pre-filter every referenced post.
    if (!isFederatedPost) {
      const viewerEntry = getViewerEntry(authorship, viewerContext.viewerId);
      // Pending collaborators may PREVIEW the post they were invited to (so the
      // collab-invite UI can render the actual content before they accept),
      // alongside the owner and accepted collaborators. All three bypass the
      // unpublished/private/followers-only/restricted ACL checks below.
      const viewerOwnsPost =
        viewerContext.viewerId === authorId ||
        (viewerEntry?.role === 'collaborator' &&
          (viewerEntry.status === 'accepted' || viewerEntry.status === 'pending'));

      if ((post.status ?? 'published') !== 'published' && !viewerOwnsPost) {
        return null;
      }

      const visibility = (post.visibility ?? PostVisibility.PUBLIC) as PostVisibility;
      if (visibility === PostVisibility.PRIVATE && !viewerOwnsPost) {
        return null;
      }

      if (visibility === PostVisibility.FOLLOWERS_ONLY && !viewerOwnsPost) {
        if (!viewerContext.viewerId || !viewerContext.follows.has(authorId)) {
          return null;
        }
      }

      if (viewerContext.restrictedIds.has(authorId) && !viewerOwnsPost) {
        return null;
      }

      // Filter posts from private/followers_only profiles. Own posts are always
      // visible; public profiles pass through.
      if (viewerContext.privateProfileIds.has(authorId) && !viewerOwnsPost) {
        if (!viewerContext.viewerId || !viewerContext.follows.has(authorId)) {
          return null;
        }
      }
    }

    // `resolveUserSummaries` always populates an entry for every requested id
    // (a real user or the degraded fallback), so this default is defensive — but
    // it must STILL never emit the raw id as a handle if ever reached.
    const user = userMap.get(authorId) ?? degradedActorSummary(authorId);
    const headerEntries = getHeaderAuthorshipEntries(authorship);
    const authors: HydratedAuthor[] = headerEntries.map((entry) => {
      const summary = userMap.get(entry.oxyUserId) ?? degradedActorSummary(entry.oxyUserId);
      return {
        ...summary,
        role: entry.role,
        status: entry.status,
      };
    });

    const content = this.buildContent(post, pollMap, params.viewerContext);
    const attachments = this.buildAttachments(post, pollMap);
    const linkPreview = linkPreviewMap.get(postId) ?? null;
    const viewerState = this.buildViewerState(postId, authorId, viewerContext, authorship);
    const permissions = this.buildPermissions(post, authorId, viewerContext, authorship);
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
      languages: post.postClassification?.languages ?? undefined,
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

    const viewerEntry = getViewerEntry(authorship, viewerContext.viewerId);
    const includeAuthorship = viewerEntry != null;

    return {
      id: postId,
      content: content ?? { text: finalText },
      attachments,
      linkPreview,
      user,
      authors,
      ...(includeAuthorship ? { authorship } : {}),
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
   * into typed {@link MediaItem}s carrying `id`/`type` plus the optional `alt`
   * (accessibility description). URL resolution is applied separately via
   * {@link resolveMediaItems}, which passes `alt` through unchanged.
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
              ...(typeof obj.alt === 'string' && obj.alt.length > 0 ? { alt: obj.alt } : {}),
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
      room: baseContent.room,
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

    const roomData = content.room;
    if (roomData) {
      attachments.room = {
        roomId: roomData.roomId,
        title: roomData.title,
        status: roomData.status,
        topic: roomData.topic,
        host: roomData.host,
      };
    }

    if (content.podcast) {
      attachments.podcast = {
        syraPodcastId: content.podcast.syraPodcastId,
        title: content.podcast.title,
        author: content.podcast.author,
        artworkUrl: content.podcast.artworkUrl,
        showUrl: content.podcast.showUrl,
      };
    }

    return attachments;
  }

  private buildViewerState(
    postId: string,
    authorId: string,
    viewerContext: ViewerContext,
    authorship: PostAuthorshipEntry[],
  ): PostViewerState {
    const viewerEntry = getViewerEntry(authorship, viewerContext.viewerId);
    const isOwner = viewerEntry?.role === 'owner';
    const isCollaborator = viewerEntry?.role === 'collaborator' && viewerEntry.status === 'accepted';

    return {
      isOwner,
      isCollaborator,
      collabInvitePending: viewerEntry?.role === 'collaborator' && viewerEntry.status === 'pending',
      viewerRole: viewerEntry?.role,
      isLiked: viewerContext.likedPosts.has(postId),
      isDownvoted: viewerContext.downvotedPosts.has(postId),
      isBoosted: viewerContext.boostedPosts.has(postId),
      isSaved: viewerContext.savedPosts.has(postId),
    };
  }

  private buildPermissions(
    post: RawPost,
    authorId: string,
    viewerContext: ViewerContext,
    authorship: PostAuthorshipEntry[],
  ): PostPermissions {
    const viewerEntry = getViewerEntry(authorship, viewerContext.viewerId);
    const isOwner = viewerEntry?.role === 'owner';
    const isAcceptedCollaborator = viewerEntry?.role === 'collaborator' && viewerEntry.status === 'accepted';
    const canReply = this.computeReplyPermission(post, authorId, viewerContext);

    return {
      canReply,
      canDelete: isOwner,
      canPin: isOwner,
      canViewSources: Boolean(post?.content?.sources?.length),
      canEdit: isOwner,
      canStopSharing: isAcceptedCollaborator,
      canViewInsights: isOwner || isAcceptedCollaborator,
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

    // Normalize the current post's declared mention IDs. The per-request
    // cache is intentionally shared across a hydration batch, so replacement
    // must be scoped to this per-post allowlist rather than every cached user.
    const declaredMentionIds = new Set<string>();
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
      if (mentionId) {
        declaredMentionIds.add(mentionId);
      }
    }

    // Collect declared mention placeholders present in the text but not yet in
    // the per-request cache. Only placeholders that actually appear are worth
    // resolving.
    const uncachedIds: string[] = [];
    for (const mentionId of declaredMentionIds) {
      if (text.includes(`[mention:${mentionId}]`) && !mentionCache.has(mentionId)) {
        uncachedIds.push(mentionId);
      }
    }

    // Resolve the uncached ids through the shared user-summary resolver: ONE
    // batched Redis read + ONE bulk service-token Oxy fetch for the misses, and
    // it writes the resolved summaries back to the Redis cache. A user who is
    // both a post author and a mention is already warm from `buildUserMap`, so
    // this never re-fetches them. Ids that only resolve to the degraded fallback
    // summary (empty handle, i.e. the lookup failed) are treated as unresolved
    // and left as the original placeholder.
    if (uncachedIds.length > 0) {
      const resolved = await resolveUserSummaries(uncachedIds);
      for (const mentionId of uncachedIds) {
        const value = resolved.get(mentionId);
        if (!value || isFallbackUserSummary(value.summary)) {
          continue;
        }
        mentionCache.set(mentionId, value.summary);
      }
    }

    // Single-pass replacement: build the placeholder→replacement map for only
    // this post's declared mention IDs, then run ONE regex over the text. An
    // undeclared or unresolved mention is left as its original placeholder.
    const replacements = new Map<string, string>();
    for (const mentionId of declaredMentionIds) {
      const mentionUser = mentionCache.get(mentionId);
      if (mentionUser) {
        // A mention with no display name renders as `@handle` — never `@undefined`.
        const mentionLabel = mentionUser.displayName?.trim() || mentionUser.handle;
        replacements.set(mentionId, `[@${mentionLabel}](${mentionUser.handle})`);
      }
    }

    return text.replace(/\[mention:([^\]]+)\]/g, (placeholder, mentionId: string) => {
      return replacements.get(mentionId) ?? placeholder;
    });
  }
}

export const postHydrationService = new PostHydrationService();
