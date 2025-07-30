/**
 * Notification-related types for Mention social network
 */

import { Timestamps } from './common';

export enum NotificationType {
  LIKE = 'like',
  REPOST = 'repost',
  COMMENT = 'comment',
  REPLY = 'reply',
  FOLLOW = 'follow',
  MENTION = 'mention',
  HASHTAG = 'hashtag',
  VERIFICATION = 'verification',
  SYSTEM = 'system',
  SECURITY = 'security',
  TRENDING = 'trending',
  RECOMMENDATION = 'recommendation'
}

export enum NotificationPriority {
  LOW = 'low',
  NORMAL = 'normal',
  HIGH = 'high',
  URGENT = 'urgent'
}

export enum NotificationStatus {
  UNREAD = 'unread',
  READ = 'read',
  ARCHIVED = 'archived',
  DELETED = 'deleted'
}

export interface Notification {
  id: string;
  _id?: string;
  oxyUserId: string; // Links to Oxy user
  type: NotificationType;
  priority: NotificationPriority;
  status: NotificationStatus;
  title: string;
  message: string;
  data: NotificationData;
  isRead: boolean;
  readAt?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationData {
  actorOxyUserId?: string; // Oxy user who triggered the notification
  targetId?: string; // post, comment, etc.
  targetType?: 'post' | 'comment' | 'user' | 'hashtag';
  actionUrl?: string; // deep link to the relevant content
  imageUrl?: string; // avatar or preview image
  metadata?: Record<string, any>;
}

export interface LikeNotification extends Notification {
  type: NotificationType.LIKE;
  data: NotificationData & {
    actorOxyUserId: string;
    targetId: string;
    targetType: 'post' | 'comment';
    postId: string;
  };
}

export interface RepostNotification extends Notification {
  type: NotificationType.REPOST;
  data: NotificationData & {
    actorOxyUserId: string;
    targetId: string;
    targetType: 'post';
    postId: string;
    isQuote: boolean;
  };
}

export interface CommentNotification extends Notification {
  type: NotificationType.COMMENT | NotificationType.REPLY;
  data: NotificationData & {
    actorOxyUserId: string;
    targetId: string;
    targetType: 'comment';
    postId: string;
    commentId: string;
    isReply: boolean;
  };
}

export interface FollowNotification extends Notification {
  type: NotificationType.FOLLOW;
  data: NotificationData & {
    actorOxyUserId: string;
    targetType: 'user';
  };
}

export interface MentionNotification extends Notification {
  type: NotificationType.MENTION;
  data: NotificationData & {
    actorOxyUserId: string;
    targetId: string;
    targetType: 'post' | 'comment';
    postId: string;
    commentId?: string;
  };
}

export interface HashtagNotification extends Notification {
  type: NotificationType.HASHTAG;
  data: NotificationData & {
    hashtag: string;
    postId: string;
    postCount: number;
  };
}

export interface VerificationNotification extends Notification {
  type: NotificationType.VERIFICATION;
  data: NotificationData & {
    status: 'approved' | 'rejected';
    reason?: string;
  };
}

export interface SystemNotification extends Notification {
  type: NotificationType.SYSTEM;
  data: NotificationData & {
    category: 'maintenance' | 'update' | 'feature' | 'announcement';
    actionRequired?: boolean;
  };
}

export interface SecurityNotification extends Notification {
  type: NotificationType.SECURITY;
  data: NotificationData & {
    event: 'login' | 'password_change' | 'email_change' | 'suspicious_activity';
    deviceInfo?: {
      deviceType: string;
      location: string;
      ipAddress: string;
    };
  };
}

export interface TrendingNotification extends Notification {
  type: NotificationType.TRENDING;
  data: NotificationData & {
    hashtag: string;
    trendDirection: 'up' | 'down';
    postCount: number;
  };
}

export interface RecommendationNotification extends Notification {
  type: NotificationType.RECOMMENDATION;
  data: NotificationData & {
    recommendedOxyUserId: string;
    reason: 'mutual_followers' | 'similar_interests' | 'location' | 'activity';
  };
}

export interface NotificationPreferences {
  email: boolean;
  push: boolean;
  sms: boolean;
  inApp: boolean;
  byType: Record<NotificationType, {
    email: boolean;
    push: boolean;
    sms: boolean;
    inApp: boolean;
  }>;
  quietHours: {
    enabled: boolean;
    startTime: string; // HH:mm format
    endTime: string; // HH:mm format
    timezone: string;
  };
}

export interface CreateNotificationRequest {
  oxyUserId: string;
  type: NotificationType;
  priority?: NotificationPriority;
  title: string;
  message: string;
  data: NotificationData;
  expiresAt?: string;
}

export interface NotificationFilters {
  type?: NotificationType;
  status?: NotificationStatus;
  priority?: NotificationPriority;
  isRead?: boolean;
  dateFrom?: string;
  dateTo?: string;
}

export interface NotificationStats {
  total: number;
  unread: number;
  byType: Record<NotificationType, number>;
  byStatus: Record<NotificationStatus, number>;
  byPriority: Record<NotificationPriority, number>;
}

export interface NotificationBatch {
  notifications: Notification[];
  hasMore: boolean;
  nextCursor?: string;
  unreadCount: number;
}

export interface MarkNotificationsRequest {
  notificationIds: string[];
  status: NotificationStatus;
  markAllAsRead?: boolean;
}

export interface NotificationSettings {
  oxyUserId: string;
  preferences: NotificationPreferences;
  createdAt: string;
  updatedAt: string;
} 