import { useTranslation } from 'react-i18next';
import { NotificationType } from '@mention/shared-types';

export interface NotificationActor {
  _id?: string;
  id?: string;
  username?: string;
  // Canonical resolved display name (profile-identity contract). The backend
  // serializer (`toPopulatedActor`) always emits `name.displayName`; clients
  // render it directly.
  name?: {
    displayName?: string;
  };
  avatar?: string;
}

export interface RawNotification {
  _id: string;
  recipientId: unknown;
  actorId: unknown;
  type: string;
  entityId: unknown;
  entityType: string;
  read: boolean;
  createdAt: string;
  updatedAt?: unknown;
  preview?: string;
  post?: {
    id?: string;
    // Canonical embedded Oxy `User` shape (matches `PostHydrationService` output
    // and `ZEmbeddedUser`): render `name.displayName`, derive the handle via
    // `getNormalizedUserHandle`, resolve `avatar` through Bloom's ImageResolver.
    user?: {
      id?: string;
      username?: string;
      name?: { displayName?: string };
      avatar?: string | null;
      verified?: boolean;
      isFederated?: boolean;
      instance?: string;
      federation?: { domain?: string };
    };
    content?: unknown;
    [key: string]: unknown;
  };
  actorId_populated?: NotificationActor;
  [key: string]: unknown;
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
  metadata?: Record<string, unknown>;
}

function isNotificationActor(value: unknown): value is NotificationActor {
  return typeof value === 'object' && value !== null;
}

/**
 * Transforms raw notification data from the database into user-friendly
 * notification objects with proper translations and formatting
 */
export const transformNotification = (
  rawNotification: RawNotification,
  t: (key: string, options?: Record<string, unknown>) => string
): TransformedNotification => {
  const actorFromActorId = isNotificationActor(rawNotification.actorId)
    ? rawNotification.actorId
    : undefined;
  // Render the canonical `name.displayName` directly (profile-identity contract);
  // the backend guarantees it on the embedded actor. `'Someone'` is the generic
  // floor when no actor is resolvable at all — NOT a name recompute.
  const actorName =
    actorFromActorId?.name?.displayName ||
    rawNotification.actorId_populated?.name?.displayName ||
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

    case 'boost':
      return {
        ...baseNotification,
        title: t('notification.boost', { actorName }),
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

    case 'collab_invite':
      return {
        ...baseNotification,
        title: t('collab.notificationInvite', { actorName, defaultValue: '{{actorName}} invited you to collaborate on a post' }),
        message: getEntityDescription(rawNotification, t),
      };

    case 'collab_accepted':
      return {
        ...baseNotification,
        title: t('collab.notificationAccepted', { actorName, defaultValue: '{{actorName}} accepted your collaboration invite' }),
        message: getEntityDescription(rawNotification, t),
      };

    case 'collab_declined':
      return {
        ...baseNotification,
        title: t('collab.notificationDeclined', { actorName, defaultValue: '{{actorName}} declined your collaboration invite' }),
        message: getEntityDescription(rawNotification, t),
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
    return `/p/${String(notification.entityId ?? '')}`;
  } else if (notification.entityType === 'profile') {
    return `/${String(notification.actorId ?? '')}`;
  }
  return '/notifications';
};

/**
 * Extracts additional metadata from the notification for display
 */
const extractMetadata = (notification: RawNotification): Record<string, unknown> => {
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
  _t: (key: string, options?: Record<string, unknown>) => string
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
