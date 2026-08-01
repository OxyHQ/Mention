import React, { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList } from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { useTheme } from '@oxyhq/bloom/theme';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTranslation } from 'react-i18next';
import { toast } from '@oxyhq/bloom/toast';
import { CalendarIcon } from '@/assets/icons/calendar-icon';
import type { ScheduledPost } from '@/hooks/useScheduledPosts';
import { confirmDialog } from '@/utils/alerts';
import { formatScheduledLabel } from '@/utils/dateUtils';
import { createLogger } from '@oxyhq/core/logger';
import { HIT_SLOP_LG } from '@/styles/hitSlop';

const logger = createLogger('ScheduledPostsList');

export interface ScheduledPostsListProps {
  posts: ScheduledPost[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  /** Cancel one scheduled post. Rejects when the server refuses. */
  onCancel: (postId: string) => Promise<void>;
}

/**
 * The viewer's SERVER-side scheduled posts.
 *
 * The counterpart to `DraftsList`: both hold something unpublished, but a draft
 * only ever exists on this device while a scheduled post is already on the
 * server waiting for its publish time — which is exactly why it needs a surface
 * of its own, and why cancelling one is a network write rather than a local
 * delete.
 */
const ScheduledPostsList: React.FC<ScheduledPostsListProps> = ({
  posts,
  isLoading,
  isError,
  onRetry,
  onCancel,
}) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const handleCancel = useCallback(async (postId: string) => {
    const confirmed = await confirmDialog({
      title: t('compose.scheduled.cancelTitle', { defaultValue: 'Cancel scheduled post' }),
      message: t('compose.scheduled.cancelConfirm', {
        defaultValue: 'This post will be deleted and never published.',
      }),
      okText: t('compose.scheduled.cancelConfirmAction', { defaultValue: 'Cancel post' }),
      cancelText: t('common.cancel'),
      destructive: true,
    });

    if (!confirmed) {
      return;
    }

    try {
      setCancellingId(postId);
      await onCancel(postId);
      toast(t('compose.scheduled.cancelled', { defaultValue: 'Scheduled post cancelled' }), { type: 'success' });
    } catch (error) {
      logger.error('Error cancelling scheduled post', error);
      toast(t('compose.scheduled.cancelError', { defaultValue: 'Failed to cancel the scheduled post' }), { type: 'error' });
    } finally {
      setCancellingId(null);
    }
  }, [onCancel, t]);

  const getPreview = useCallback((post: ScheduledPost) => {
    if (post.text) {
      return post.text.length > 100 ? `${post.text.substring(0, 100)}...` : post.text;
    }
    if (post.articleTitle) {
      return post.articleTitle;
    }
    if (post.mediaCount > 0) {
      return post.mediaCount === 1
        ? t('compose.draftWithMedia', { count: post.mediaCount })
        : t('compose.draftWithMedia_plural', { count: post.mediaCount });
    }
    if (post.hasPoll) {
      return t('compose.draftWithPoll');
    }
    return t('compose.emptyDraft');
  }, [t]);

  const renderItem = useCallback(({ item }: { item: ScheduledPost }) => {
    const isCancelling = cancellingId === item.id;

    return (
      <View className="flex-row items-center px-4 py-3 bg-background border-b border-border">
        <View className="flex-1 mr-3">
          <View className="flex-row items-center gap-1.5 mb-1">
            <CalendarIcon size={14} color={theme.colors.primary} />
            <Text className="text-xs font-semibold" style={{ color: theme.colors.primary }}>
              {item.scheduledFor
                ? formatScheduledLabel(item.scheduledFor)
                : t('compose.scheduled.unknownTime', { defaultValue: 'Time unavailable' })}
            </Text>
          </View>
          <Text className="text-sm text-foreground mb-1" numberOfLines={2}>
            {getPreview(item)}
          </Text>
          {(item.mediaCount > 0 || item.hasPoll) && (
            <View className="flex-row items-center gap-3 mt-1">
              {item.mediaCount > 0 && (
                <View className="flex-row items-center gap-1">
                  <Ionicons name="image-outline" size={14} color={theme.colors.textSecondary} />
                  <Text className="text-xs text-muted-foreground">
                    {item.mediaCount}
                  </Text>
                </View>
              )}
              {item.hasPoll && (
                <Ionicons name="stats-chart-outline" size={14} color={theme.colors.textSecondary} />
              )}
            </View>
          )}
        </View>
        <TouchableOpacity
          className="p-1"
          onPress={() => handleCancel(item.id)}
          disabled={isCancelling}
          hitSlop={HIT_SLOP_LG}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={t('compose.scheduled.cancelTitle', { defaultValue: 'Cancel scheduled post' })}
        >
          {isCancelling ? (
            <Loading className="text-primary" variant="inline" size="small" style={{ flex: undefined }} />
          ) : (
            <Ionicons name="trash-outline" size={18} color={theme.colors.textSecondary} />
          )}
        </TouchableOpacity>
      </View>
    );
  }, [cancellingId, getPreview, handleCancel, t, theme]);

  if (isLoading) {
    return (
      <View className="flex-1 justify-center items-center py-12">
        <Loading className="text-primary" size="large" />
      </View>
    );
  }

  if (isError) {
    return (
      <View className="flex-1 justify-center items-center py-12 px-8">
        <Text className="text-base text-center text-muted-foreground">
          {t('compose.scheduled.loadError', { defaultValue: "We couldn't load your scheduled posts" })}
        </Text>
        <TouchableOpacity
          className="mt-4 px-4 py-2 rounded-full bg-primary"
          onPress={onRetry}
          activeOpacity={0.85}
        >
          <Text className="text-sm font-semibold" style={{ color: theme.colors.card }}>
            {t('common.retry', { defaultValue: 'Retry' })}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (posts.length === 0) {
    return (
      <View className="flex-1 justify-center items-center py-12 px-8">
        <CalendarIcon size={64} className="text-muted-foreground" color={theme.colors.textTertiary} />
        <Text className="mt-6 text-xl font-semibold text-foreground">
          {t('compose.scheduled.empty', { defaultValue: 'No scheduled posts' })}
        </Text>
        <Text className="mt-2 text-base text-center text-muted-foreground">
          {t('compose.scheduled.emptyDescription', {
            defaultValue: 'Posts you schedule will wait here until it is time to publish them.',
          })}
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      data={posts}
      renderItem={renderItem}
      keyExtractor={(item) => item.id}
      className="flex-1"
    />
  );
};

export default ScheduledPostsList;
