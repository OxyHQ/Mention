import React, { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList } from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { useTheme } from '@oxyhq/bloom/theme';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTranslation } from 'react-i18next';
import { toast } from '@oxyhq/bloom/toast';
import { getNormalizedUserHandle } from '@oxyhq/core';
import type { HydratedPost } from '@mention/shared-types';
import { CalendarIcon } from '@/assets/icons/calendar-icon';
import { isPastDue, scheduledDate } from '@/utils/postSchedule';
import { confirmDialog } from '@/utils/alerts';
import { formatScheduledLabel } from '@/utils/dateUtils';
import { createLogger } from '@oxyhq/core/logger';
import { HIT_SLOP_LG } from '@/styles/hitSlop';

const logger = createLogger('ScheduledPostsList');

export interface ScheduledPostsListProps {
  posts: HydratedPost[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  /**
   * The signed-in reader, so a row can say whose queue it is in.
   *
   * This list is no longer only the reader's own: `GET /posts/scheduled` returns
   * the shared editorial queue of every CHANNEL they operate, so that two people
   * publishing under one byline can see each other's plans instead of both
   * booking Tuesday. Every entry names its authoring account (`post.user`, which
   * IS the channel — a channel authors its own posts), and the id is what tells
   * "mine" from "the channel's".
   *
   * Optional because the sheet can render for a split second before the session
   * lands; an absent viewer labels nothing rather than labelling everything.
   */
  viewerId?: string;
  /** Open the full preview for one post. */
  onPreview: (post: HydratedPost) => void;
  /** Load one post back into the composer to rewrite or reschedule it. */
  onEdit: (post: HydratedPost) => void;
  /** Cancel one scheduled post. Rejects when the server refuses. */
  onCancel: (postId: string) => Promise<void>;
}

/**
 * Ask before deleting a scheduled post, then delete it.
 *
 * Shared with the preview so the two surfaces can never disagree about what the
 * user was told — including the past-due case, where the honest wording is that
 * the post may already have gone out (the publisher sweeps every 60s) and is
 * being deleted either way.
 */
export async function confirmAndCancel(params: {
  post: HydratedPost;
  onCancel: (postId: string) => Promise<void>;
  t: (key: string, options?: Record<string, unknown>) => string;
}): Promise<boolean> {
  const { post, onCancel, t } = params;
  const pastDue = isPastDue(post);

  const confirmed = await confirmDialog({
    title: t('compose.scheduled.cancelTitle', { defaultValue: 'Cancel scheduled post' }),
    message: pastDue
      ? t('compose.scheduled.cancelConfirmPastDue', {
          defaultValue: 'Its time has passed, so it may already have been published. Either way this post will be deleted.',
        })
      : t('compose.scheduled.cancelConfirm', {
          defaultValue: 'This post will be deleted and never published.',
        }),
    okText: t('compose.scheduled.cancelConfirmAction', { defaultValue: 'Cancel post' }),
    cancelText: t('common.cancel'),
    destructive: true,
  });

  if (!confirmed) {
    return false;
  }

  try {
    await onCancel(post.id);
    toast(t('compose.scheduled.cancelled', { defaultValue: 'Scheduled post cancelled' }), { type: 'success' });
    return true;
  } catch (error) {
    logger.error('Error cancelling scheduled post', error);
    toast(t('compose.scheduled.cancelError', { defaultValue: 'Failed to cancel the scheduled post' }), { type: 'error' });
    return false;
  }
}

/**
 * The viewer's SERVER-side scheduled posts.
 *
 * The counterpart to `DraftsList`: both hold something unpublished, but a draft
 * only ever exists on this device while a scheduled post is already on the
 * server waiting for its publish time — which is why cancelling one is a network
 * write, and why previewing one is worth doing: this is the last look before it
 * goes out on its own.
 */
const ScheduledPostsList: React.FC<ScheduledPostsListProps> = ({
  posts,
  isLoading,
  isError,
  onRetry,
  onPreview,
  onEdit,
  onCancel,
  viewerId,
}) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const handleCancel = useCallback(async (post: HydratedPost) => {
    setCancellingId(post.id);
    try {
      await confirmAndCancel({ post, onCancel, t });
    } finally {
      setCancellingId(null);
    }
  }, [onCancel, t]);

  const getPreview = useCallback((post: HydratedPost) => {
    const text = post.content?.text?.trim();
    if (text) {
      return text.length > 100 ? `${text.substring(0, 100)}...` : text;
    }
    const articleTitle = post.content?.article?.title?.trim();
    if (articleTitle) {
      return articleTitle;
    }
    const mediaCount = post.content?.media?.length ?? 0;
    if (mediaCount > 0) {
      return mediaCount === 1
        ? t('compose.draftWithMedia', { count: mediaCount })
        : t('compose.draftWithMedia_plural', { count: mediaCount });
    }
    if (post.content?.poll ?? post.content?.pollId) {
      return t('compose.draftWithPoll');
    }
    return t('compose.emptyDraft');
  }, [t]);

  const renderItem = useCallback(({ item }: { item: HydratedPost }) => {
    const isCancelling = cancellingId === item.id;
    const publishAt = scheduledDate(item);
    const mediaCount = item.content?.media?.length ?? 0;
    const hasPoll = Boolean(item.content?.poll ?? item.content?.pollId);

    // A past-due row must not keep advertising a future time: by then the 60s
    // publisher sweep may already have sent it.
    const timeLabel = publishAt === null
      ? t('compose.scheduled.unknownTime', { defaultValue: 'Time unavailable' })
      : isPastDue(item)
        ? t('compose.scheduled.publishing', { defaultValue: 'Publishing now…' })
        : formatScheduledLabel(publishAt);

    // Whose queue this entry is in. Only shown for an account that is NOT the
    // reader — labelling their own posts "you" on every row would be noise, and
    // the absence of a label is already the clearest possible "mine".
    //
    // It deliberately names the ACCOUNT and never the person who queued it: a
    // channel's writers are anonymous unless it signs its posts, and that
    // decision is made on the server. When a channel DOES sign, the writer is
    // already in `authors[]` and the preview's byline draws them — so this row
    // never has to make a disclosure judgement of its own.
    // `viewerId` is checked FIRST and not merely compared: it is absent for the
    // moment between mount and the session landing, and `author.id !== undefined`
    // is true of every row — so comparing alone labels the reader's own posts as
    // somebody else's during exactly the window nobody watches.
    const author = item.user;
    const queuedFor =
      author !== undefined && viewerId !== undefined && author.id !== viewerId
        ? author.name?.displayName?.trim() || getNormalizedUserHandle(author) || undefined
        : undefined;

    return (
      <View className="flex-row items-center px-4 py-3 bg-background border-b border-border">
        <TouchableOpacity
          className="flex-1 flex-row items-center"
          onPress={() => onPreview(item)}
          disabled={isCancelling}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={t('compose.scheduled.previewA11y', { defaultValue: 'Preview scheduled post' })}
        >
          <View className="flex-1 mr-3">
            <View className="flex-row items-center gap-1.5 mb-1">
              <CalendarIcon size={14} color={theme.colors.primary} />
              <Text className="text-xs font-semibold" style={{ color: theme.colors.primary }}>
                {timeLabel}
              </Text>
              {queuedFor !== undefined && (
                <Text
                  className="text-xs text-muted-foreground flex-shrink"
                  numberOfLines={1}
                  accessibilityLabel={t('compose.scheduled.queuedForA11y', {
                    defaultValue: 'Queued for {{account}}',
                    account: queuedFor,
                  })}
                >
                  {queuedFor}
                </Text>
              )}
            </View>
            <Text className="text-sm text-foreground mb-1" numberOfLines={2}>
              {getPreview(item)}
            </Text>
            {(mediaCount > 0 || hasPoll) && (
              <View className="flex-row items-center gap-3 mt-1">
                {mediaCount > 0 && (
                  <View className="flex-row items-center gap-1">
                    <Ionicons name="image-outline" size={14} color={theme.colors.textSecondary} />
                    <Text className="text-xs text-muted-foreground">
                      {mediaCount}
                    </Text>
                  </View>
                )}
                {hasPoll && (
                  <Ionicons name="stats-chart-outline" size={14} color={theme.colors.textSecondary} />
                )}
              </View>
            )}
          </View>
          <Ionicons name="chevron-forward" size={20} color={theme.colors.textSecondary} />
        </TouchableOpacity>
        <TouchableOpacity
          className="p-1 mr-1"
          onPress={() => onEdit(item)}
          disabled={isCancelling}
          hitSlop={HIT_SLOP_LG}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={t('compose.scheduled.edit', { defaultValue: 'Edit scheduled post' })}
        >
          <Ionicons name="create-outline" size={18} color={theme.colors.textSecondary} />
        </TouchableOpacity>
        <TouchableOpacity
          className="p-1"
          onPress={() => handleCancel(item)}
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
  }, [cancellingId, getPreview, handleCancel, onEdit, onPreview, t, theme, viewerId]);

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
