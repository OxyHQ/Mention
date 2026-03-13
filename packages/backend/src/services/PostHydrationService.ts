import { FeedPostSlice, FeedSliceItem, HydratedPost, HydratedPostSummary, HydratedRepostContext, PostActorSummary, PostAttachmentBundle, PostEngagementSummary, PostLinkPreview, PostPermissions, PostViewerState } from '@mention/shared-types';
import mongoose from 'mongoose';
import { Post } from '../models/Post';
import Poll from '../models/Poll';
import Like from '../models/Like';
import Bookmark from '../models/Bookmark';
import { UserSettings } from '../models/UserSettings';
import { oxy as defaultOxyClient } from '../../server';
import { linkMetadataService } from './linkMetadataService';
import { getBlockedUserIds, getRestrictedUserIds, extractFollowingIds, extractFollowersIds, OxyClient } from '../utils/privacyHelpers';
import { logger } from '../utils/logger';
import { assignThreadState } from './ThreadSlicingService';

interface HydrationOptions {
  viewerId?: string;
  oxyClient?: OxyClient; // Per-request OxyServices instance with user's auth token
  maxDepth?: number;
  includeLinkMetadata?: boolean;
  includeFullArticleBody?: boolean; // For feed, skip full article bodies
  includeFullMetadata?: boolean; // For feed, skip some metadata fields
}

interface HydratedGraphNode {
  post: any;
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
  savedPosts: Set<string>;
  repostedPosts: Set<string>;
  /** Author IDs with private or followers_only profile visibility */
  privateProfileIds: Set<string>;
}

const DEFAULT_PRIVACY = {
  hideLikeCounts: false,
  hideShareCounts: false,
  hideReplyCounts: false,
  hideSaveCounts: false,
};

export class PostHydrationService {
  async hydratePosts(rawPosts: any[], options: HydrationOptions = {}): Promise<HydratedPost[]> {
    if (!Array.isArray(rawPosts) || rawPosts.length === 0) {
      return [];
    }

    const maxDepth = Math.max(0, options.maxDepth ?? 1);
    const viewerContext = await this.buildViewerContext(rawPosts, options.viewerId, options);

    const initialPosts = rawPosts
      .map((post) => (typeof post?.toObject === 'function' ? post.toObject() : post))
      .filter((post) => post && (post.oxyUserId || (post as any).federatedActorId)
        && (!post.oxyUserId || !viewerContext.blockedIds.has(String(post.oxyUserId))));

    if (initialPosts.length === 0) {
      return [];
    }

    const graph = await this.collectPostsWithDepth(initialPosts, maxDepth, viewerContext.blockedIds);

    const postIds = Array.from(graph.keys());
    const postsForHydration = Array.from(graph.values());

    await this.populateViewerInteractions(postIds, viewerContext);

    // Pre-collect replier user IDs so we can batch them into the main user fetch
    const replierAggResult = await this.aggregateRecentReplierIds(postIds);

    const pollMap = await this.buildPollMap(postsForHydration);
    const userMap = await this.buildUserMap(postsForHydration, replierAggResult.allReplierIds);
    const mentionCache: Map<string, PostActorSummary> = new Map(userMap);
    const authorPrivacyMap = await this.buildAuthorPrivacyMap(postsForHydration, viewerContext);

    const linkPreviewMap = options.includeLinkMetadata !== false
      ? await this.buildLinkPreviewMap(postsForHydration)
      : new Map<string, PostLinkPreview>();

    // Build replier avatar map using the already-populated userMap (no extra fetches)
    const recentReplierMap = this.buildReplierAvatarsFromUserMap(replierAggResult.perPostRepliers, userMap);

    const summaryMap = new Map<string, HydratedPostSummary>();

    for (const { post } of postsForHydration) {
      const summary = await this.buildPostSummary({
        post,
        viewerContext,
        pollMap,
        userMap,
        mentionCache,
        linkPreviewMap,
        authorPrivacyMap,
        recentReplierMap,
      });

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
    const allRawPosts: any[] = [];
    const postIdToSlicePositions = new Map<string, Array<{ sliceIdx: number; itemIdx: number }>>();

    for (let si = 0; si < slices.length; si++) {
      for (let ii = 0; ii < slices[si].items.length; ii++) {
        const rawPost = slices[si].items[ii].post;
        const postId = rawPost?.id || (rawPost as any)?._id?.toString() || '';
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
        const postId = item.post?.id || (item.post as any)?._id?.toString() || '';
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

  private async buildViewerContext(posts: any[], viewerId?: string, options?: HydrationOptions): Promise<ViewerContext & { includeFullArticleBody?: boolean; includeFullMetadata?: boolean }> {
    const context: ViewerContext & { includeFullArticleBody?: boolean; includeFullMetadata?: boolean } = {
      viewerId,
      privacyPreferences: { ...DEFAULT_PRIVACY },
      blockedIds: new Set<string>(),
      restrictedIds: new Set<string>(),
      follows: new Set<string>(),
      followedBy: new Set<string>(),
      likedPosts: new Set<string>(),
      savedPosts: new Set<string>(),
      repostedPosts: new Set<string>(),
      privateProfileIds: new Set<string>(),
      includeFullArticleBody: options?.includeFullArticleBody ?? true,
      includeFullMetadata: options?.includeFullMetadata ?? true,
    };

    // Collect unique author IDs for profile visibility check
    const authorIds = Array.from(
      new Set(posts.map((p) => p?.oxyUserId).filter(Boolean).map((id) => String(id))),
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
          const vis = (s as any).privacy?.profileVisibility;
          if (vis === 'private' || vis === 'followers_only') {
            context.privateProfileIds.add(authorId);
          }

          // Cache engagement privacy for buildAuthorPrivacyMap
          authorPrivacyCache.set(authorId, {
            hideLikeCounts: Boolean((s as any).privacy?.hideLikeCounts),
            hideShareCounts: Boolean((s as any).privacy?.hideShareCounts),
            hideReplyCounts: Boolean((s as any).privacy?.hideReplyCounts),
            hideSaveCounts: Boolean((s as any).privacy?.hideSaveCounts),
          });
        }

        // Set defaults for authors without settings
        for (const authorId of authorIds) {
          if (!authorPrivacyCache.has(authorId)) {
            authorPrivacyCache.set(authorId, { ...DEFAULT_PRIVACY });
          }
        }

        (context as any)._authorPrivacyCache = authorPrivacyCache;
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
        oxyForFollows.getUserFollowing(viewerId).catch((error: any) => {
          logger.warn('[PostHydration] getUserFollowing failed:', error);
          return [];
        }),
        oxyForFollows.getUserFollowers(viewerId).catch((error: any) => {
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

  private async collectPostsWithDepth(
    initialPosts: any[],
    maxDepth: number,
    blockedIds: Set<string>,
  ): Promise<Map<string, HydratedGraphNode>> {
    const result = new Map<string, HydratedGraphNode>();
    const visited = new Set<string>();

    let currentLevel = initialPosts.map((post) => ({ post, depth: 0 }));

    for (let depth = 0; depth <= maxDepth && currentLevel.length > 0; depth++) {
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

        if (entry.depth >= maxDepth) {
          continue;
        }

        const referenceIds = this.extractReferenceIds(entry.post);
        for (const refId of referenceIds) {
          if (!refId || visited.has(refId)) continue;
          if (!nextIdMap.has(refId)) {
            nextIdMap.set(refId, entry.depth + 1);
          } else {
            nextIdMap.set(refId, Math.min(nextIdMap.get(refId)!, entry.depth + 1));
          }
        }
      }

      if (nextIdMap.size === 0) {
        break;
      }

      const nextIds = Array.from(nextIdMap.keys());
      try {
        const fetched = await Post.find({ _id: { $in: nextIds } })
          .select('-metadata.likedBy -metadata.savedBy')
          .lean();

        currentLevel = fetched.map((post) => ({
          post,
          depth: nextIdMap.get(this.resolveId(post)!) ?? depth + 1,
        }));
      } catch (error) {
        logger.error('[PostHydration] Failed to fetch referenced posts:', error);
        break;
      }
    }

    return result;
  }

  private extractReferenceIds(post: any): string[] {
    const ids: string[] = [];
    const maybePush = (value: any) => {
      if (!value) return;
      if (typeof value === 'string') {
        ids.push(value);
        return;
      }
      if (typeof value === 'object') {
        const refId = value._id ?? value.id ?? value.postId;
        if (refId) {
          ids.push(String(refId));
        }
      }
    };

    maybePush(post.repostOf);
    maybePush(post.quoteOf);
    if (post.originalPostId) {
      maybePush(post.originalPostId);
    }
    return ids.filter(Boolean);
  }

  private resolveId(post: any): string {
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
      const [likes, bookmarks, reposts] = await Promise.all([
        Like.find({ userId: viewerId, postId: { $in: postIds } }).select('postId').lean(),
        Bookmark.find({ userId: viewerId, postId: { $in: postIds } }).select('postId').lean(),
        Post.find({ oxyUserId: viewerId, repostOf: { $in: postIds } }).select('repostOf').lean(),
      ]);

      likes.forEach((like: any) => {
        const id = like?.postId ? String(like.postId) : undefined;
        if (id) viewerContext.likedPosts.add(id);
      });

      bookmarks.forEach((bookmark: any) => {
        const id = bookmark?.postId ? String(bookmark.postId) : undefined;
        if (id) viewerContext.savedPosts.add(id);
      });

      reposts.forEach((post: any) => {
        const id = post?.repostOf ? String(post.repostOf) : undefined;
        if (id) viewerContext.repostedPosts.add(id);
      });
    } catch (error) {
      logger.error('[PostHydration] Failed to populate viewer interactions:', error);
    }
  }

  private async buildPollMap(nodes: HydratedGraphNode[]): Promise<Map<string, any>> {
    const pollIds = Array.from(
      new Set(
        nodes
          .map(({ post }) => post?.content?.pollId || post?.metadata?.pollId)
          .filter(Boolean)
          .map((id: any) => String(id)),
      ),
    );

    if (pollIds.length === 0) {
      return new Map();
    }

    try {
      const polls = await Poll.find({ _id: { $in: pollIds } }).lean();
      const map = new Map<string, any>();

      polls.forEach((poll) => {
        const id = poll?._id ? String(poll._id) : undefined;
        if (!id) return;

        map.set(id, {
          question: poll.question,
          options: poll.options.map((opt: any) => opt.text),
          endTime: poll.endsAt?.toISOString?.() ?? poll.endsAt ?? new Date().toISOString(),
          votes: poll.options.reduce((acc: Record<string, number>, opt: any, index: number) => {
            acc[String(index)] = Array.isArray(opt.votes) ? opt.votes.length : 0;
            return acc;
          }, {}),
          userVotes: poll.options.reduce((acc: Record<string, string>, opt: any, index: number) => {
            if (Array.isArray(opt.votes)) {
              opt.votes.forEach((userId: any) => {
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
    const userMap = new Map<string, PostActorSummary>();

    // Separate local users from federated actors
    const localUserIds = new Set<string>();
    const federatedActorIds = new Set<string>();

    for (const { post } of nodes) {
      if ((post as any)?.federatedActorId) {
        federatedActorIds.add(String((post as any).federatedActorId));
      } else if (post?.oxyUserId) {
        localUserIds.add(String(post.oxyUserId));
      }
    }

    // Merge in extra user IDs (e.g., replier IDs) for batch fetching
    if (extraLocalUserIds) {
      for (const id of extraLocalUserIds) {
        localUserIds.add(id);
      }
    }

    // Batch-fetch federated actors from local DB (not Oxy)
    if (federatedActorIds.size > 0) {
      try {
        const FederatedActor = require('../models/FederatedActor.js').default;
        const actors = await FederatedActor.find({
          _id: { $in: [...federatedActorIds] },
        }).lean();
        for (const actor of actors) {
          const actorIdStr = String(actor._id);
          userMap.set(actorIdStr, {
            id: actorIdStr,
            handle: actor.username,
            displayName: actor.displayName || actor.username,
            name: actor.displayName || actor.username,
            avatarUrl: actor.avatarUrl,
            avatar: actor.avatarUrl,
            badges: undefined,
            isVerified: false,
            isFederated: true,
            instance: actor.domain,
            actorUri: actor.uri,
            profileUrl: actor.uri,
          });
        }
      } catch {
        // Federation models may not exist yet
      }
    }

    // Fetch local Oxy users (existing logic)
    const userIds = [...localUserIds];
    if (userIds.length > 0) {
      await Promise.all(
        userIds.map(async (userId) => {
          try {
            const userData: any = await defaultOxyClient.getUserById(userId);
            const username: string = String(userData?.username || userData?.handle || userId);
            const displayName: string = String(userData?.name?.full || userData?.displayName || username || userId);
            const avatarValue: string | undefined = typeof userData?.avatar === 'string'
              ? userData.avatar
              : (userData?.avatar as any)?.url || userData?.profileImage || undefined;

            userMap.set(userId, {
              id: String(userData?.id || userId),
              handle: username,
              displayName: displayName,
              name: displayName,
              avatarUrl: avatarValue,
              avatar: avatarValue,
              badges: Array.isArray(userData.badges)
                ? userData.badges.map((badge: any) => (typeof badge === 'string' ? badge : badge?.name)).filter(Boolean)
                : undefined,
              isVerified: Boolean(userData.verified || userData.isVerified),
            });
          } catch (error) {
            logger.warn(`[PostHydration] Failed to load user ${userId}:`, error);
            userMap.set(userId, {
              id: userId,
              handle: userId,
              displayName: 'User',
              name: 'User',
              avatarUrl: undefined,
              avatar: undefined,
              badges: undefined,
              isVerified: false,
            });
          }
        }),
      );
    }

    return userMap;
  }

  private async buildLinkPreviewMap(nodes: HydratedGraphNode[]): Promise<Map<string, PostLinkPreview>> {
    const previewMap = new Map<string, PostLinkPreview>();

    const urlToPosts = new Map<string, string[]>(); // url -> [postId]

    // Only process top-level posts (depth 0) for link previews in feed
    // Nested posts (reposts/quotes) don't need link previews
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
    
    // Limit concurrent link metadata fetches to avoid overwhelming the service
    const BATCH_SIZE = 5;
    for (let i = 0; i < uniqueUrls.length; i += BATCH_SIZE) {
      const batch = uniqueUrls.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (url) => {
          try {
            const metadata = await linkMetadataService.fetchMetadata(url);
            const preview: PostLinkPreview = {
              url: metadata.url,
              title: metadata.title || undefined,
              description: metadata.description || undefined,
              image: metadata.image || undefined,
              siteName: metadata.siteName || undefined,
            };

            urlToPosts.get(url)?.forEach((postId) => previewMap.set(postId, preview));
          } catch (error) {
            logger.warn('[PostHydration] Failed to fetch link metadata for', url, error);
          }
        }),
      );
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
    const cached = (viewerContext as any)?._authorPrivacyCache as Map<string, typeof DEFAULT_PRIVACY> | undefined;
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
        const ids = (entry.replierIds || []).map((id: any) => String(id));
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

  private async buildRecentReplierAvatarsMap(
    postIds: string[],
    userMap: Map<string, PostActorSummary>,
  ): Promise<Map<string, string[]>> {
    const replierMap = new Map<string, string[]>();
    if (postIds.length === 0) return replierMap;

    try {
      const objectIds = postIds.map((id) => {
        try { return new mongoose.Types.ObjectId(id); } catch { return id; }
      });

      // Find up to 3 recent unique repliers per post (preserving recency order)
      const recentReplies = await Post.aggregate([
        { $match: { parentPostId: { $in: objectIds } } },
        { $sort: { createdAt: -1 } },
        { $group: {
          _id: '$parentPostId',
          replierIds: { $push: '$oxyUserId' },
        }},
        { $project: {
          _id: 1,
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

      // Collect all replier IDs we need to look up
      const allReplierIds = new Set<string>();
      for (const entry of recentReplies) {
        for (const id of entry.replierIds) {
          const sid = String(id);
          if (!userMap.has(sid)) allReplierIds.add(sid);
        }
      }

      // Fetch missing replier profiles individually (same pattern as buildUserMap)
      if (allReplierIds.size > 0) {
        await Promise.all(
          Array.from(allReplierIds).map(async (userId) => {
            try {
              const userData: any = await defaultOxyClient.getUserById(userId);
              const avatarValue = typeof userData?.avatar === 'string'
                ? userData.avatar
                : (userData?.avatar as any)?.url || userData?.profileImage || undefined;
              userMap.set(userId, {
                id: String(userData?.id || userId),
                handle: String(userData?.username || userData?.handle || userId),
                displayName: String(userData?.name?.full || userData?.displayName || userId),
                name: String(userData?.name?.full || userData?.displayName || userId),
                avatar: avatarValue,
                avatarUrl: avatarValue,
                badges: undefined,
                isVerified: Boolean(userData?.verified || userData?.isVerified),
              });
            } catch {
              // Non-critical: skip this replier's avatar
            }
          }),
        );
      }

      for (const entry of recentReplies) {
        const parentId = String(entry._id);
        const avatars: string[] = [];
        for (const replierId of entry.replierIds) {
          const user = userMap.get(String(replierId));
          if (user?.avatar) {
            avatars.push(user.avatar);
          }
        }
        if (avatars.length > 0) {
          replierMap.set(parentId, avatars);
        }
      }
    } catch (error) {
      logger.warn('[PostHydration] Failed to load recent replier avatars:', error);
    }

    return replierMap;
  }

  private async buildPostSummary(params: {
    post: any;
    viewerContext: ViewerContext;
    pollMap: Map<string, any>;
    userMap: Map<string, PostActorSummary>;
    mentionCache: Map<string, PostActorSummary>;
    linkPreviewMap: Map<string, PostLinkPreview>;
    authorPrivacyMap: Map<string, typeof DEFAULT_PRIVACY>;
    recentReplierMap?: Map<string, string[]>;
  }): Promise<HydratedPostSummary | null> {
    const { post, viewerContext, pollMap, userMap, mentionCache, linkPreviewMap, authorPrivacyMap, recentReplierMap } = params;

    const postId = this.resolveId(post);
    if (!postId) return null;

    // Resolve author ID: use oxyUserId for local posts, federatedActorId for federated posts
    const authorId = post?.oxyUserId
      ? String(post.oxyUserId)
      : (post as any)?.federatedActorId
        ? String((post as any).federatedActorId)
        : undefined;
    if (!authorId) return null;

    // Privacy checks only apply to local users (federated posts are public by definition)
    const isFederatedPost = !!(post as any)?.federatedActorId;
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

    const user = userMap.get(authorId) ?? {
      id: authorId,
      handle: authorId,
      displayName: 'User',
      name: 'User',
      avatarUrl: undefined,
      avatar: undefined,
      badges: undefined,
      isVerified: false,
    };

    const content = this.buildContent(post, pollMap, params.viewerContext);
    const attachments = this.buildAttachments(post, pollMap);
    const linkPreview = linkPreviewMap.get(postId) ?? null;
    const viewerState = this.buildViewerState(postId, authorId, viewerContext);
    const permissions = await this.buildPermissions(post, authorId, viewerContext);
    const authorPrivacy = authorPrivacyMap.get(authorId) ?? { ...DEFAULT_PRIVACY };
    const replierAvatars = recentReplierMap?.get(postId);
    const engagement = this.buildEngagement(post, authorPrivacy, replierAvatars);

    // Only include essential metadata for feed performance
    const includeFullMetadata = (params.viewerContext as any).includeFullMetadata !== false;
    const metadata = {
      visibility: post.visibility,
      replyPermission: post.replyPermission,
      reviewReplies: Boolean(post.reviewReplies),
      isPinned: Boolean(post.metadata?.isPinned),
      isSensitive: Boolean(post.metadata?.isSensitive),
      isThread: Boolean(post.threadId),
      language: post.language || undefined,
      // Only include tags/hashtags if needed (can be large arrays)
      tags: includeFullMetadata && Array.isArray(post.tags) && post.tags.length > 0 ? post.tags : undefined,
      mentions: includeFullMetadata && Array.isArray(post.mentions) && post.mentions.length > 0 ? post.mentions : undefined,
      hashtags: includeFullMetadata && Array.isArray(post.hashtags) && post.hashtags.length > 0 ? post.hashtags : undefined,
      createdAt: new Date(post.createdAt || post.date || Date.now()).toISOString(),
      updatedAt: new Date(post.updatedAt || post.createdAt || Date.now()).toISOString(),
      status: post.status,
    };

    // Always replace mentions in text if they exist, regardless of includeFullMetadata
    // This ensures mentions are always displayed correctly
    let finalText = content?.text ?? '';
    const postMentions = Array.isArray(post.mentions) && post.mentions.length > 0 ? post.mentions : [];
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

  private buildContent(post: any, pollMap: Map<string, any>, viewerContext?: ViewerContext): any {
    const baseContent = post?.content ?? {};

    const media = Array.isArray(baseContent.media)
      ? baseContent.media
          .map((item: any) => {
            if (!item) return undefined;
            if (typeof item === 'string') {
              return { id: item, type: 'image' };
            }
            if (typeof item === 'object' && item.id) {
              return {
                id: String(item.id),
                type: item.type === 'video' || item.type === 'gif' ? item.type : 'image',
              };
            }
            return undefined;
          })
          .filter(Boolean)
      : undefined;

    const pollId = baseContent.pollId || post?.metadata?.pollId;
    const poll = pollId ? pollMap.get(String(pollId)) : undefined;

    return {
      text: typeof baseContent.text === 'string' ? baseContent.text : '',
      media,
      poll,
      pollId: pollId ? String(pollId) : undefined,
      // For feed, only include article metadata, not full body (saves bandwidth)
      article: baseContent.article
        ? {
            articleId: baseContent.article.articleId || baseContent.article.id,
            title: baseContent.article.title,
            excerpt: baseContent.article.excerpt,
            // Only include body if explicitly requested (e.g., for detail view)
            ...((viewerContext as any)?.includeFullArticleBody && baseContent.article.body
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

  private buildAttachments(post: any, pollMap: Map<string, any>): PostAttachmentBundle {
    const content = post?.content ?? {};
    const attachments: PostAttachmentBundle = {};

    if (Array.isArray(content.media) && content.media.length > 0) {
      attachments.media = content.media
        .map((item: any) => {
          if (!item) return undefined;
          if (typeof item === 'string') {
            return { id: String(item), type: 'image' as const };
          }
          if (typeof item === 'object' && item.id) {
            return {
              id: String(item.id),
              type: item.type === 'video' || item.type === 'gif' ? item.type : 'image',
            };
          }
          return undefined;
        })
        .filter(Boolean) as any;
    }

    const pollId = content.pollId || post?.metadata?.pollId;
    if (pollId) {
      const poll = pollMap.get(String(pollId));
      if (poll) {
        attachments.poll = poll;
      }
    } else if (content.poll) {
      attachments.poll = content.poll;
    }

    if (content.article) {
      attachments.article = {
        articleId: content.article.articleId ?? content.article.id,
        title: content.article.title,
        body: content.article.body,
        excerpt: content.article.excerpt,
      };
    }

    if (Array.isArray(content.sources) && content.sources.length > 0) {
      attachments.sources = content.sources.map((source: any) => ({
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
        roomId: roomData.roomId ?? roomData.spaceId,
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
      isReposted: viewerContext.repostedPosts.has(postId),
      isSaved: viewerContext.savedPosts.has(postId),
    };
  }

  private async buildPermissions(post: any, authorId: string, viewerContext: ViewerContext): Promise<PostPermissions> {
    const isOwner = viewerContext.viewerId === authorId;
    const canReply = await this.computeReplyPermission(post, authorId, viewerContext);

    return {
      canReply,
      canDelete: isOwner,
      canPin: isOwner,
      canViewSources: Boolean(post?.content?.sources?.length),
      canEdit: isOwner,
    };
  }

  private async computeReplyPermission(post: any, authorId: string, viewerContext: ViewerContext): Promise<boolean> {
    const viewerId = viewerContext.viewerId;
    if (!viewerId) return false;
    if (viewerId === authorId) return true;

    const permission = post?.replyPermission || 'anyone';
    switch (permission) {
      case 'anyone':
        return true;
      case 'followers':
        return viewerContext.follows.has(authorId);
      case 'following':
        return viewerContext.followedBy.has(authorId);
      case 'mentioned':
        return Array.isArray(post?.mentions)
          ? post.mentions.some((mention: any) => {
              const mentionId =
                typeof mention === 'string' ? mention : mention?.id || mention?._id || mention?.oxyUserId;
              return mentionId && String(mentionId) === viewerId;
            })
          : false;
      default:
        return false;
    }
  }

  private buildEngagement(
    post: any,
    authorPrivacy: typeof DEFAULT_PRIVACY,
    recentReplierAvatars?: string[],
  ): PostEngagementSummary {
    const stats = post?.stats || {};
    const metadata = post?.metadata || {};

    const likesCount = typeof stats.likesCount === 'number' ? stats.likesCount : 0;
    const repostsCount = typeof stats.repostsCount === 'number' ? stats.repostsCount : 0;
    const repliesCount = typeof stats.commentsCount === 'number' ? stats.commentsCount : 0;
    const savesCount = Array.isArray(metadata.savedBy) ? metadata.savedBy.length : undefined;

    const viewsCount = typeof stats.viewsCount === 'number' ? stats.viewsCount : 0;

    return {
      likes: authorPrivacy.hideLikeCounts ? null : likesCount,
      reposts: authorPrivacy.hideShareCounts ? null : repostsCount,
      replies: authorPrivacy.hideReplyCounts ? null : repliesCount,
      saves: authorPrivacy.hideSaveCounts ? null : savesCount ?? null,
      views: viewsCount > 0 ? viewsCount : null,
      impressions: null,
      recentReplierAvatars: recentReplierAvatars?.length ? recentReplierAvatars : undefined,
    };
  }

  private attachNestedContext(
    post: any,
    summary: HydratedPostSummary,
    summaryMap: Map<string, HydratedPostSummary>,
    viewerContext: ViewerContext,
  ): HydratedPost | null {
    const postId = summary.id;
    const repostOf = post?.repostOf ? String(post.repostOf) : undefined;
    const quoteOf = post?.quoteOf ? String(post.quoteOf) : undefined;

    let originalPost: HydratedPostSummary | null = null;
    if (repostOf) {
      originalPost = summaryMap.get(repostOf) ?? null;
    } else if (quoteOf) {
      originalPost = summaryMap.get(quoteOf) ?? null;
    }

    const quotedPost = quoteOf ? summaryMap.get(quoteOf) ?? null : null;
    const repostOriginal = repostOf ? summaryMap.get(repostOf) ?? null : null;
    const repostContext: HydratedRepostContext | null = repostOf && repostOriginal
      ? {
          originalPost: repostOriginal,
          actor: summary.user,
        }
      : null;

    const context = this.buildContext(post);

    return {
      ...summary,
      originalPost,
      quotedPost,
      repost: repostContext,
      context,
    };
  }

  private buildContext(post: any) {
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

    // Normalize mention IDs and collect uncached ones that have placeholders in text
    const normalizedIds: string[] = [];
    const uncachedIds: string[] = [];
    for (const mentionIdRaw of mentions) {
      let mentionId: string;
      if (typeof mentionIdRaw === 'string') {
        mentionId = mentionIdRaw;
      } else if (mentionIdRaw && typeof mentionIdRaw === 'object') {
        const raw = mentionIdRaw as any;
        mentionId = String(raw?.id || raw?._id || raw || '');
      } else {
        mentionId = String(mentionIdRaw || '');
      }
      normalizedIds.push(mentionId);
      if (mentionId && text.includes(`[mention:${mentionId}]`) && !mentionCache.has(mentionId)) {
        uncachedIds.push(mentionId);
      }
    }

    // Fetch all uncached mentions in parallel instead of sequentially
    if (uncachedIds.length > 0) {
      await Promise.all(uncachedIds.map(async (mentionId) => {
        try {
          const userData = await defaultOxyClient.getUserById(mentionId);
          const username = userData.username || mentionId;

          // Use proper full name fallback chain: name.full → name.first + name.last → displayName → username
          let fullName: string;
          if (userData.name?.full) {
            fullName = userData.name.full;
          } else if (userData.name?.first) {
            fullName = `${userData.name.first} ${userData.name.last || ''}`.trim();
          } else if (userData.displayName) {
            fullName = typeof userData.displayName === 'string' ? userData.displayName : String(userData.displayName || username);
          } else {
            fullName = username;
          }

          const avatarValue = typeof userData.avatar === 'string'
            ? userData.avatar
            : (userData.avatar as any)?.url || userData.profileImage || undefined;

          mentionCache.set(mentionId, {
            id: userData.id || mentionId,
            handle: username,
            displayName: fullName,
            name: fullName,
            avatarUrl: avatarValue,
            avatar: avatarValue,
            badges: Array.isArray(userData.badges)
              ? userData.badges
                  .map((badge: any) => (typeof badge === 'string' ? badge : badge?.name))
                  .filter(Boolean)
              : undefined,
            isVerified: Boolean(userData.verified || userData.isVerified),
          });
        } catch (error) {
          logger.warn(`[PostHydration] Failed to resolve mention ${mentionId}:`, error);
          mentionCache.set(mentionId, {
            id: mentionId,
            handle: mentionId,
            displayName: 'User',
            name: 'User',
            avatarUrl: undefined,
            avatar: undefined,
            badges: undefined,
            isVerified: false,
          });
        }
      }));
    }

    // Replace all placeholders from cache
    let result = text;
    for (const mentionId of normalizedIds) {
      if (!mentionId || !result.includes(`[mention:${mentionId}]`)) continue;
      const mentionUser = mentionCache.get(mentionId);
      if (mentionUser) {
        const placeholder = `[mention:${mentionId}]`;
        const replacement = `[@${mentionUser.displayName}](${mentionUser.handle})`;
        result = result.split(placeholder).join(replacement);
      }
    }

    return result;
  }
}

export const postHydrationService = new PostHydrationService();

