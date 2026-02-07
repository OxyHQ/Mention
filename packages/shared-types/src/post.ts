/**
 * Post-related types for Mention social network
 */

import { GeoJSONPoint } from './common';

export enum PostType {
  TEXT = 'text',
  IMAGE = 'image',
  VIDEO = 'video',
  POLL = 'poll',
  REPOST = 'repost',
  QUOTE = 'quote'
}

export enum PostVisibility {
  PUBLIC = 'public',
  FOLLOWERS_ONLY = 'followers_only',
  PRIVATE = 'private'
}

export interface MediaItem {
  id: string;
  type: 'image' | 'video' | 'gif';
}

export type PostAttachmentType = 'media' | 'poll' | 'article' | 'location' | 'sources' | 'event' | 'space';

export interface PostAttachmentDescriptor {
  type: PostAttachmentType;
  id?: string; // For media attachments and other id-referenced attachments
  mediaType?: 'image' | 'video' | 'gif';
}

export interface PostSourceLink {
  url: string;
  title?: string;
}

export interface PostArticleContent {
  articleId?: string;
  title?: string;
  body?: string;
  excerpt?: string;
}

export interface PostEventContent {
  eventId?: string;
  name: string;
  date: string; // ISO date string
  location?: string;
  description?: string;
}

export interface PostSpaceContent {
  spaceId: string;
  title: string;
  status?: 'scheduled' | 'live' | 'ended';
  topic?: string;
  host?: string;
}

export interface PostContent {
  text?: string;
  media?: MediaItem[]; // Media items for images and videos
  poll?: PollData; // Populated poll data for display
  pollId?: string; // Reference to poll document
  location?: GeoJSONPoint; // Location shared by user as part of post content
  sources?: PostSourceLink[]; // External sources cited within the post content
  article?: PostArticleContent; // Optional article content authored with the post
  event?: PostEventContent; // Optional event content
  space?: PostSpaceContent; // Optional space content
  attachments?: PostAttachmentDescriptor[]; // Ordered attachments for rendering (media, poll, article, event, etc.)
}

export interface PollData {
  question: string;
  options: string[];
  endTime: string;
  votes: Record<string, number>; // option index -> vote count
  userVotes: Record<string, string>; // userId -> option index
}

export type ReplyPermission = 'anyone' | 'followers' | 'following' | 'mentioned';

export interface Post {
  id: string;
  _id?: string;
  oxyUserId: string; // Links to Oxy user
  type: PostType;
  content: PostContent;
  visibility: PostVisibility;
  isEdited: boolean;
  editHistory?: string[];
  language?: string;
  tags?: string[];
  mentions?: string[]; // oxyUserIds
  hashtags?: string[];
  repostOf?: string; // original post id
  quoteOf?: string; // quoted post id
  parentPostId?: string; // for replies
  threadId?: string; // for thread posts
  replyPermission?: ReplyPermission; // Who can reply and quote this post
  reviewReplies?: boolean; // Whether to review and approve replies before they're visible
  stats: PostStats;
  metadata: PostMetadata;
  location?: GeoJSONPoint; // Post creation location metadata
  status?: 'draft' | 'published' | 'scheduled';
  scheduledFor?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PostStats {
  likesCount: number;
  repostsCount: number;
  commentsCount: number;
  viewsCount: number;
  sharesCount: number;
}

export interface PostMetadata {
  isSensitive?: boolean;
  isPinned?: boolean;
  isBookmarked?: boolean;
  isLiked?: boolean;
  isReposted?: boolean;
  isCommented?: boolean;
  isFollowingAuthor?: boolean;
  authorBlocked?: boolean;
  authorMuted?: boolean;
  hideEngagementCounts?: boolean;
  // Track user interactions
  likedBy?: string[]; // Array of user IDs who liked this post
  savedBy?: string[]; // Array of user IDs who saved this post
}

export interface CreatePostRequest {
  content: PostContent;
  visibility?: PostVisibility;
  parentPostId?: string;
  threadId?: string;
  tags?: string[];
  mentions?: string[];
  hashtags?: string[];
  replyPermission?: ReplyPermission;
  reviewReplies?: boolean;
  status?: 'draft' | 'published' | 'scheduled';
  scheduledFor?: string;
}

export interface CreateThreadRequest {
  mode: 'thread' | 'beast'; // thread = linked posts, beast = separate posts
  posts: {
    content: PostContent;
    visibility?: PostVisibility;
    tags?: string[];
    mentions?: string[];
    hashtags?: string[];
    replyPermission?: ReplyPermission;
    reviewReplies?: boolean;
  }[];
}

export interface UpdatePostRequest {
  content?: PostContent;
  visibility?: PostVisibility;
  tags?: string[];
  mentions?: string[];
  hashtags?: string[];
}

export interface PostFeed {
  posts: Post[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface PostFilters {
  authorId?: string;
  type?: PostType;
  visibility?: PostVisibility;
  hashtags?: string[];
  mentions?: string[];
  dateFrom?: string;
  dateTo?: string;
  isEdited?: boolean;
} 

/**
 * Normalized API response structures for hydrated posts
 */

export interface PostActorSummary {
  id: string;
  handle: string;
  displayName: string;
  name?: string;
  avatarUrl?: string;
  avatar?: string;
  badges?: string[];
  isVerified?: boolean;
}

export interface PostViewerState {
  isOwner: boolean;
  isLiked: boolean;
  isReposted: boolean;
  isSaved: boolean;
}

export interface PostPermissions {
  canReply: boolean;
  canDelete: boolean;
  canPin: boolean;
  canViewSources: boolean;
  canEdit?: boolean;
}

export interface PostEngagementSummary {
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  saves?: number | null;
  views?: number | null;
  impressions?: number | null;
}

export interface PostAttachmentBundle {
  media?: MediaItem[];
  poll?: PollData;
  article?: PostArticleContent;
  sources?: PostSourceLink[];
  location?: GeoJSONPoint;
  event?: PostEventContent;
  space?: PostSpaceContent;
}

export interface PostLinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

export interface PostFeedContext {
  reason?: string;
  position?: number;
  parentThreadId?: string;
  isThreadParent?: boolean;
}

export interface PostMetadataState {
  visibility: PostVisibility;
  replyPermission?: ReplyPermission;
  reviewReplies?: boolean;
  isPinned?: boolean;
  isSensitive?: boolean;
  hideEngagementCounts?: boolean;
  isThread?: boolean;
  language?: string;
  tags?: string[];
  mentions?: string[];
  hashtags?: string[];
  createdAt: string;
  updatedAt: string;
  status?: 'draft' | 'published' | 'scheduled';
}

export interface HydratedPostSummary {
  id: string;
  content: PostContent;
  attachments: PostAttachmentBundle;
  linkPreview?: PostLinkPreview | null;
  user: PostActorSummary;
  engagement: PostEngagementSummary;
  viewerState: PostViewerState;
  permissions: PostPermissions;
  metadata: PostMetadataState;
}

export interface HydratedRepostContext {
  originalPost: HydratedPostSummary;
  actor: PostActorSummary;
  reason?: string;
}

export interface HydratedPost extends HydratedPostSummary {
  originalPost?: HydratedPostSummary | null;
  quotedPost?: HydratedPostSummary | null;
  repost?: HydratedRepostContext | null;
  context?: PostFeedContext;
}