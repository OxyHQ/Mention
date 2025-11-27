import { HydratedPost, HydratedPostSummary, HydratedRepostContext, PostActorSummary, PostAttachmentBundle, PostEngagementSummary, PostLinkPreview, PostPermissions, PostViewerState } from '@mention/shared-types';
import { Post } from '../models/Post';
import Poll from '../models/Poll';
import Like from '../models/Like';
import Bookmark from '../models/Bookmark';
import { UserSettings } from '../models/UserSettings';
import { oxy as oxyClient } from '../../server';
import { linkMetadataService } from './linkMetadataService';
import { getBlockedUserIds, getRestrictedUserIds, extractFollowingIds, extractFollowersIds } from '../utils/privacyHelpers';
import { logger } from '../utils/logger';

interface HydrationOptions {
  viewerId?: string;
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
      .filter((post) => post && post.oxyUserId && !viewerContext.blockedIds.has(String(post.oxyUserId)));

    if (initialPosts.length === 0) {
      return [];
    }

    const graph = await this.collectPostsWithDepth(initialPosts, maxDepth, viewerContext.blockedIds);

    const postIds = Array.from(graph.keys());
    const postsForHydration = Array.from(graph.values());

    await this.populateViewerInteractions(postIds, viewerContext);

    const pollMap = await this.buildPollMap(postsForHydration);
    const userMap = await this.buildUserMap(postsForHydration);
    const mentionCache: Map<string, PostActorSummary> = new Map(userMap);
    const authorPrivacyMap = await this.buildAuthorPrivacyMap(postsForHydration);

    const linkPreviewMap = options.includeLinkMetadata !== false
      ? await this.buildLinkPreviewMap(postsForHydration)
      : new Map<string, PostLinkPreview>();

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
      includeFullArticleBody: options?.includeFullArticleBody ?? true,
      includeFullMetadata: options?.includeFullMetadata ?? true,
    };

    if (!viewerId) {
      return context;
    }

    try {
      const [blockedIds, restrictedIds] = await Promise.all([
        getBlockedUserIds().catch((error) => {
          logger.warn('[PostHydration] Failed to load blocked users:', error);
          return [] as string[];
        }),
        getRestrictedUserIds().catch((error) => {
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
      const [followingResponse, followersResponse] = await Promise.all([
        oxyClient.getUserFollowing(viewerId).catch((error: any) => {
          logger.warn('[PostHydration] getUserFollowing failed:', error);
          return [];
        }),
        oxyClient.getUserFollowers(viewerId).catch((error: any) => {
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

  private async buildUserMap(nodes: HydratedGraphNode[]): Promise<Map<string, PostActorSummary>> {
    const userIds = Array.from(new Set(nodes.map(({ post }) => post?.oxyUserId).filter(Boolean))).map((id) =>
      String(id),
    );

    const userMap = new Map<string, PostActorSummary>();
    if (userIds.length === 0) {
      return userMap;
    }

    await Promise.all(
      userIds.map(async (userId) => {
        try {
          const userData: any = await oxyClient.getUserById(userId);
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

  private async buildAuthorPrivacyMap(nodes: HydratedGraphNode[]): Promise<Map<string, typeof DEFAULT_PRIVACY>> {
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

      // Set defaults for authors without settings
      authorIds.forEach((authorId) => {
        if (!privacyMap.has(authorId)) {
          privacyMap.set(authorId, { ...DEFAULT_PRIVACY });
        }
      });
    } catch (error) {
      logger.warn('[PostHydration] Failed to load author privacy settings:', error);
      // Set defaults for all authors on error
      authorIds.forEach((authorId) => {
        privacyMap.set(authorId, { ...DEFAULT_PRIVACY });
      });
    }

    return privacyMap;
  }

  private async buildPostSummary(params: {
    post: any;
    viewerContext: ViewerContext;
    pollMap: Map<string, any>;
    userMap: Map<string, PostActorSummary>;
    mentionCache: Map<string, PostActorSummary>;
    linkPreviewMap: Map<string, PostLinkPreview>;
    authorPrivacyMap: Map<string, typeof DEFAULT_PRIVACY>;
  }): Promise<HydratedPostSummary | null> {
    const { post, viewerContext, pollMap, userMap, mentionCache, linkPreviewMap, authorPrivacyMap } = params;

    const postId = this.resolveId(post);
    if (!postId) return null;

    const authorId = post?.oxyUserId ? String(post.oxyUserId) : undefined;
    if (!authorId) return null;

    if (viewerContext.restrictedIds.has(authorId) && viewerContext.viewerId !== authorId) {
      return null;
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
    const engagement = this.buildEngagement(post, authorPrivacy);

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

    // Only replace mentions if we have them and they're needed
    // For feed, we can skip this expensive operation if mentions aren't being used
    let finalText = content?.text ?? '';
    if (metadata.mentions && metadata.mentions.length > 0 && finalText.includes('[mention:')) {
      finalText = await this.replaceMentionPlaceholders(
        finalText,
        metadata.mentions,
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
  ): PostEngagementSummary {
    const stats = post?.stats || {};
    const metadata = post?.metadata || {};

    const likesCount = typeof stats.likesCount === 'number' ? stats.likesCount : 0;
    const repostsCount = typeof stats.repostsCount === 'number' ? stats.repostsCount : 0;
    const repliesCount = typeof stats.commentsCount === 'number' ? stats.commentsCount : 0;
    const savesCount = Array.isArray(metadata.savedBy) ? metadata.savedBy.length : undefined;

    return {
      likes: authorPrivacy.hideLikeCounts ? null : likesCount,
      reposts: authorPrivacy.hideShareCounts ? null : repostsCount,
      replies: authorPrivacy.hideReplyCounts ? null : repliesCount,
      saves: authorPrivacy.hideSaveCounts ? null : savesCount ?? null,
      views: null,
      impressions: null,
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

    let result = text;

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
      
      if (!mentionId || !result.includes(`[mention:${mentionId}]`)) continue;

      let mentionUser = mentionCache.get(mentionId);
      if (!mentionUser) {
        try {
          const userData = await oxyClient.getUserById(mentionId);
          const username = userData.username || mentionId;
          const displayName = userData.name?.full || username || mentionId;
          const avatarValue = typeof userData.avatar === 'string'
            ? userData.avatar
            : (userData.avatar as any)?.url || userData.profileImage || undefined;
          
          mentionUser = {
            id: userData.id || mentionId,
            handle: username,
            displayName: displayName,
            name: displayName,
            avatarUrl: avatarValue,
            avatar: avatarValue,
            badges: Array.isArray(userData.badges)
              ? userData.badges
                  .map((badge: any) => (typeof badge === 'string' ? badge : badge?.name))
                  .filter(Boolean)
              : undefined,
            isVerified: Boolean(userData.verified || userData.isVerified),
          };
          mentionCache.set(mentionId, mentionUser);
        } catch (error) {
          logger.warn(`[PostHydration] Failed to resolve mention ${mentionId}:`, error);
          mentionUser = {
            id: mentionId,
            handle: mentionId,
            displayName: 'User',
            name: 'User',
            avatarUrl: undefined,
            avatar: undefined,
            badges: undefined,
            isVerified: false,
          };
          mentionCache.set(mentionId, mentionUser);
        }
      }

      const placeholder = `[mention:${mentionId}]`;
      const replacement = `[@${mentionUser.displayName}](${mentionUser.handle})`;
      result = result.split(placeholder).join(replacement);
    }

    return result;
  }
}

export const postHydrationService = new PostHydrationService();

