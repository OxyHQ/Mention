import { useTranslation } from 'react-i18next';
import { NotificationType } from '@mention/shared-types';

export interface RawNotification {
  _id: string;
  recipientId: string;
  actorId: any;
  type: string;
  entityId: string;
  entityType: string;
  read: boolean;
  createdAt: string;
  updatedAt: string;
  preview?: string;
  actorId_populated?: {
    _id: string;
    username: string;
    name: string;
    avatar?: string;
  };
}

export interface TransformedNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  actorName: string;
  actorAvatar?: string;
  isRead: boolean;
  createdAt: string;
  actionUrl?: string;
  metadata?: Record<string, any>;
}

/**
 * Transforms raw notification data from the database into user-friendly
 * notification objects with proper translations and formatting
 */
export const transformNotification = (
  rawNotification: RawNotification,
  t: (key: string, options?: any) => string
): TransformedNotification => {
  const actorFromActorId = typeof rawNotification.actorId === 'object' && rawNotification.actorId !== null
    ? rawNotification.actorId
    : undefined;
  const actorName = actorFromActorId?.name ||
    actorFromActorId?.username ||
    rawNotification.actorId_populated?.name ||
    rawNotification.actorId_populated?.username ||
    'Someone';

  const baseNotification = {
    id: rawNotification._id,
    type: rawNotification.type as NotificationType,
    actorName,
  actorAvatar: actorFromActorId?.avatar || rawNotification.actorId_populated?.avatar,
    isRead: rawNotification.read,
    createdAt: rawNotification.createdAt,
    actionUrl: getActionUrl(rawNotification),
    metadata: extractMetadata(rawNotification),
  };

  // Transform based on notification type
  switch (rawNotification.type) {
    case 'like':
      return {
        ...baseNotification,
        title: t('notification.like', { actorName }),
        message: getEntityDescription(rawNotification, t),
      };

    case 'reply':
      return {
        ...baseNotification,
        title: t('notification.reply', { actorName }),
        message: getEntityDescription(rawNotification, t),
      };

    case 'mention':
      return {
        ...baseNotification,
        title: t('notification.mention', { actorName }),
        message: getEntityDescription(rawNotification, t),
      };

    case 'follow':
      return {
        ...baseNotification,
        title: t('notification.follow', { actorName }),
        message: t('notification.follow_request', { actorName }),
      };

    case 'repost':
      return {
        ...baseNotification,
        title: t('notification.repost', { actorName }),
        message: getEntityDescription(rawNotification, t),
      };

    case 'quote':
      return {
        ...baseNotification,
        title: t('notification.quote', { actorName }),
        message: getEntityDescription(rawNotification, t),
      };

    case 'welcome':
      return {
        ...baseNotification,
        title: t('notification.welcome.title'),
        message: t('notification.welcome.body'),
      };
    case 'post':
      return {
        ...baseNotification,
        title: t('notification.post', { actorName, defaultValue: `${actorName} posted a new update` }),
        message: rawNotification.preview || getEntityDescription(rawNotification, t),
      };

    default:
      return {
        ...baseNotification,
        title: t('notification.like', { actorName }),
        message: getEntityDescription(rawNotification, t),
      };
  }
};

/**
 * Gets the action URL for navigation based on notification type and entity
 */
const getActionUrl = (notification: RawNotification): string => {
  if (notification.entityType === 'post' || notification.entityType === 'reply') {
    return `/p/${notification.entityId}`;
  } else if (notification.entityType === 'profile') {
    return `/${notification.actorId}`;
  }
  return '/notifications';
};

/**
 * Extracts additional metadata from the notification for display
 */
const extractMetadata = (notification: RawNotification): Record<string, any> => {
  return {
    entityId: notification.entityId,
    entityType: notification.entityType,
    actorId: notification.actorId,
  };
};

/**
 * Gets a description of the entity that was interacted with
 */
const getEntityDescription = (
  notification: RawNotification,
  _t: (key: string, options?: any) => string
): string => {
  // This would typically fetch the actual post/reply content
  // For now, we'll return a generic description
  if (notification.entityType === 'post') {
    return 'your post';
  } else if (notification.entityType === 'reply') {
    return 'your reply';
  } else if (notification.entityType === 'profile') {
    return 'your profile';
  }
  return 'your content';
};

/**
 * Hook for transforming notifications with translations
 */
export const useNotificationTransformer = () => {
  const { t } = useTranslation();

  const transformNotifications = (rawNotifications: RawNotification[]): TransformedNotification[] => {
    return rawNotifications.map(notification => transformNotification(notification, t));
  };

  const transformSingleNotification = (rawNotification: RawNotification): TransformedNotification => {
    return transformNotification(rawNotification, t);
  };

  return {
    transformNotifications,
    transformSingleNotification,
  };
};
