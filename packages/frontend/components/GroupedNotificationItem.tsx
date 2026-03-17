import React, { useCallback } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ThemedText } from './ThemedText';
import { Avatar } from '@oxyhq/bloom/avatar';
import { cn } from '@/lib/utils';
import type { GroupedNotification } from '@/utils/groupNotifications';

interface GroupedNotificationItemProps {
  group: GroupedNotification;
  onMarkAsRead: (notificationId: string) => void;
}

export const GroupedNotificationItem: React.FC<GroupedNotificationItemProps> = ({
  group,
  onMarkAsRead,
}) => {
  const router = useRouter();
  const { t } = useTranslation();

  const handlePress = useCallback(() => {
    // Mark all unread notifications in the group as read
    if (group.hasUnread) {
      for (const id of group.notificationIds) {
        onMarkAsRead(id);
      }
    }

    // Navigate based on entity type
    const lead = group.leadNotification;
    if (lead.entityType === 'post' || lead.entityType === 'reply') {
      router.push(`/p/${group.entityId}`);
    } else if (lead.entityType === 'profile') {
      const actorId = typeof lead.actorId === 'string' ? lead.actorId : (lead.actorId as any)?._id;
      router.push(`/${actorId}`);
    }
  }, [group, onMarkAsRead, router]);

  const getNotificationIcon = (type: string): string => {
    switch (type) {
      case 'like': return 'heart';
      case 'repost': return 'repeat';
      case 'follow': return 'person-add';
      case 'quote': return 'chatbox-ellipses';
      default: return 'notifications';
    }
  };

  const getNotificationColor = (type: string): string => {
    switch (type) {
      case 'like': return '#22c55e';
      case 'follow': return '#005c67';
      case 'repost': return '#005c67';
      case 'quote': return '#005c67';
      default: return '#005c67';
    }
  };

  const formatTimeAgo = (dateString: string): string => {
    const now = new Date();
    const date = new Date(dateString);
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diffInSeconds < 60) return t('notification.now');
    if (diffInSeconds < 3600) return t('notification.minutes_ago', { count: Math.floor(diffInSeconds / 60) });
    if (diffInSeconds < 86400) return t('notification.hours_ago', { count: Math.floor(diffInSeconds / 3600) });
    if (diffInSeconds < 604800) return t('notification.days_ago', { count: Math.floor(diffInSeconds / 86400) });
    return date.toLocaleDateString();
  };

  const buildGroupTitle = (): string => {
    const names = group.actors.map(a => a.name || 'Someone');
    const remaining = group.totalActors - names.length;

    // Build the actor string: "Alice, Bob, and 3 others"
    let actorString: string;
    if (names.length === 1 && remaining === 0) {
      actorString = names[0];
    } else if (names.length === 2 && remaining === 0) {
      actorString = t('notification.group.two_actors', {
        actor1: names[0],
        actor2: names[1],
        defaultValue: `${names[0]} and ${names[1]}`,
      });
    } else if (remaining > 0) {
      const displayedNames = names.slice(0, 2).join(', ');
      actorString = t('notification.group.many_actors', {
        actors: displayedNames,
        count: remaining,
        defaultValue: `${displayedNames} and ${remaining} ${remaining === 1 ? 'other' : 'others'}`,
      });
    } else {
      actorString = names.join(', ');
    }

    // Build the action string based on type
    switch (group.type) {
      case 'like':
        return t('notification.group.liked', {
          actors: actorString,
          defaultValue: `${actorString} liked your post`,
        });
      case 'repost':
        return t('notification.group.reposted', {
          actors: actorString,
          defaultValue: `${actorString} reposted your post`,
        });
      case 'follow':
        return t('notification.group.followed', {
          actors: actorString,
          defaultValue: `${actorString} followed you`,
        });
      case 'quote':
        return t('notification.group.quoted', {
          actors: actorString,
          defaultValue: `${actorString} quoted your post`,
        });
      default:
        return `${actorString} interacted with your content`;
    }
  };

  return (
    <TouchableOpacity
      className={cn("border-border", group.hasUnread && "bg-primary/5")}
      style={styles.container}
      onPress={handlePress}
    >
      {/* Avatar + action badge */}
      <View style={styles.avatarContainer}>
        <Avatar source={group.actors[0]?.avatar} size={40} />
        <View className="border-background" style={[styles.actionBadge, { backgroundColor: getNotificationColor(group.type) }]}>
          <Ionicons name={getNotificationIcon(group.type) as any} size={12} color="#fff" />
        </View>
      </View>

      <View style={styles.contentContainer}>
        {/* Stacked avatars row (when multiple actors) */}
        {group.actors.length > 1 && (
          <View style={styles.avatarRow}>
            {group.actors.map((actor, index) => (
              <View
                key={actor.id}
                style={[
                  styles.avatarWrapper,
                  { marginLeft: index > 0 ? -8 : 0, zIndex: group.actors.length - index },
                ]}
              >
                <View className="border-background" style={styles.avatarBorder}>
                  <Avatar source={actor.avatar} size={24} />
                </View>
              </View>
            ))}
            {group.totalActors > group.actors.length && (
              <View style={[styles.avatarWrapper, { marginLeft: -8, zIndex: 0 }]}>
                <View className="bg-primary border-background" style={styles.moreAvatarBadge}>
                  <ThemedText style={styles.moreAvatarText}>
                    +{group.totalActors - group.actors.length}
                  </ThemedText>
                </View>
              </View>
            )}
          </View>
        )}

        {/* Group text */}
        <ThemedText
          className={cn("text-muted-foreground", group.hasUnread && "text-foreground")}
          style={[
            styles.message,
            group.hasUnread && styles.unreadText,
          ]}
          numberOfLines={2}
        >
          {buildGroupTitle()}
        </ThemedText>

        <ThemedText className="text-muted-foreground" style={styles.timestamp}>
          {formatTimeAgo(group.createdAt)}
        </ThemedText>
      </View>

      {group.hasUnread && (
        <View className="bg-primary" style={styles.unreadIndicator} />
      )}
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    backgroundColor: 'transparent',
  },
  unreadContainer: {},
  avatarContainer: {
    position: 'relative',
    marginRight: 12,
  },
  actionBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 20,
    height: 20,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
  },
  contentContainer: {
    flex: 1,
  },
  avatarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  avatarWrapper: {},
  avatarBorder: {
    borderWidth: 2,
    borderRadius: 14,
  },
  moreAvatarBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  moreAvatarText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
  },
  message: {
    fontSize: 14,
    lineHeight: 18,
    marginBottom: 4,
  },
  unreadText: {
    fontWeight: '700',
  },
  timestamp: {
    fontSize: 12,
  },
  unreadIndicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    alignSelf: 'center',
  },
});
