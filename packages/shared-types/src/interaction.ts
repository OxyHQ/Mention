/**
 * Interaction-related types for Mention social network
 */

import { Timestamps } from './common';

export enum InteractionType {
  LIKE = 'like',
  REPOST = 'repost',
  COMMENT = 'comment',
  SHARE = 'share',
  BOOKMARK = 'bookmark',
  FOLLOW = 'follow',
  BLOCK = 'block',
  MUTE = 'mute',
  REPORT = 'report'
}

export enum InteractionStatus {
  ACTIVE = 'active',
  REMOVED = 'removed',
  HIDDEN = 'hidden'
}

export interface Interaction {
  id: string;
  _id?: string;
  oxyUserId: string; // Links to Oxy user
  targetId: string; // postId, oxyUserId, etc.
  targetType: 'post' | 'user' | 'comment';
  type: InteractionType;
  status: InteractionStatus;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface Like {
  id: string;
  oxyUserId: string;
  postId: string;
  createdAt: string;
}

export interface Repost {
  id: string;
  oxyUserId: string;
  originalPostId: string;
  comment?: string; // optional comment with repost
  isQuote: boolean; // true if it's a quote post, false if it's a repost
  createdAt: string;
}

export interface Comment {
  id: string;
  _id?: string;
  postId: string;
  oxyUserId: string; // Links to Oxy user
  content: string;
  parentCommentId?: string; // for nested comments
  mentions?: string[]; // oxyUserIds
  hashtags?: string[];
  isEdited: boolean;
  editHistory?: string[];
  stats: CommentStats;
  metadata: CommentMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface CommentStats {
  likesCount: number;
  repliesCount: number;
  repostsCount: number;
}

export interface CommentMetadata {
  isLiked?: boolean;
  isAuthor?: boolean;
  authorBlocked?: boolean;
  authorMuted?: boolean;
}

export interface Follow {
  id: string;
  followerOxyUserId: string;
  followingOxyUserId: string;
  isPending: boolean; // for private accounts
  createdAt: string;
}

export interface Block {
  id: string;
  blockerOxyUserId: string;
  blockedOxyUserId: string;
  reason?: string;
  createdAt: string;
}

export interface Mute {
  id: string;
  muterOxyUserId: string;
  mutedOxyUserId: string;
  reason?: string;
  duration?: number; // in seconds, undefined for permanent
  createdAt: string;
  expiresAt?: string;
}

export interface Bookmark {
  id: string;
  oxyUserId: string;
  postId: string;
  folder?: string; // optional folder name
  createdAt: string;
}

export interface Report {
  id: string;
  reporterOxyUserId: string;
  targetId: string;
  targetType: 'post' | 'user' | 'comment';
  reason: ReportReason;
  description?: string;
  evidence?: string[]; // URLs to evidence
  status: ReportStatus;
  moderatorOxyUserId?: string;
  moderatorNotes?: string;
  resolvedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export enum ReportReason {
  SPAM = 'spam',
  HARASSMENT = 'harassment',
  HATE_SPEECH = 'hate_speech',
  VIOLENCE = 'violence',
  SEXUAL_CONTENT = 'sexual_content',
  MISINFORMATION = 'misinformation',
  COPYRIGHT = 'copyright',
  IMPERSONATION = 'impersonation',
  OTHER = 'other'
}

export enum ReportStatus {
  PENDING = 'pending',
  UNDER_REVIEW = 'under_review',
  RESOLVED = 'resolved',
  DISMISSED = 'dismissed'
}

export interface CreateCommentRequest {
  postId: string;
  content: string;
  parentCommentId?: string;
  mentions?: string[];
  hashtags?: string[];
}

export interface UpdateCommentRequest {
  content: string;
  mentions?: string[];
  hashtags?: string[];
}

export interface CreateReportRequest {
  targetId: string;
  targetType: 'post' | 'user' | 'comment';
  reason: ReportReason;
  description?: string;
  evidence?: string[];
}

export interface InteractionFilters {
  oxyUserId?: string;
  targetId?: string;
  targetType?: 'post' | 'user' | 'comment';
  type?: InteractionType;
  status?: InteractionStatus;
  dateFrom?: string;
  dateTo?: string;
}

export interface InteractionStats {
  totalLikes: number;
  totalReposts: number;
  totalComments: number;
  totalShares: number;
  totalBookmarks: number;
  totalFollows: number;
  totalBlocks: number;
  totalMutes: number;
  totalReports: number;
} 