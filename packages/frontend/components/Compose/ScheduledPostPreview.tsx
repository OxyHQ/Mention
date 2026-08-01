import React, { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { useTheme } from '@oxyhq/bloom/theme';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTranslation } from 'react-i18next';
import type { HydratedPost } from '@mention/shared-types';
import PostItem from '@/components/Feed/PostItem';
import { CalendarIcon } from '@/assets/icons/calendar-icon';
import { isPastDue, scheduledDate } from '@/utils/postSchedule';
import { confirmAndCancel } from './ScheduledPostsList';
import { formatScheduledLabel } from '@/utils/dateUtils';
import { HIT_SLOP_LG } from '@/styles/hitSlop';

export interface ScheduledPostPreviewProps {
  post: HydratedPost;
  onBack: () => void;
  /** Load the previewed post back into the composer. */
  onEdit: () => void;
  /** Cancel the previewed post. Rejects when the server refuses. */
  onCancel: (postId: string) => Promise<void>;
  /** Called after a successful cancel, so the sheet can leave the preview. */
  onCancelled: () => void;
}

/**
 * How a scheduled post will actually look once it publishes.
 *
 * It renders through `PostItem` — the SAME component the feed and the post
 * detail render — deliberately: a preview built from its own markup would start
 * telling the truth and quietly stop the first time either side changed, and a
 * preview that lies about the outcome is worse than none. This is possible only
 * because `GET /posts/scheduled` now serves the hydrated DTO, so media carries
 * display URLs and the poll/quote/article are already built.
 *
 * The post is rendered INERT (`pointerEvents="none"`). Two reasons, both real:
 * `PostItem`'s tap target opens `/p/<id>`, which for an unpublished post is a
 * 404 by the very ACL that protects it; and liking, boosting or voting on a post
 * that has not been published yet is not a meaningful action. Scrolling still
 * works — the ScrollView is outside the inert subtree.
 */
const ScheduledPostPreview: React.FC<ScheduledPostPreviewProps> = ({
  post,
  onBack,
  onEdit,
  onCancel,
  onCancelled,
}) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const [isCancelling, setIsCancelling] = useState(false);

  const publishAt = scheduledDate(post);
  const pastDue = isPastDue(post);

  const handleCancel = useCallback(async () => {
    setIsCancelling(true);
    try {
      const cancelled = await confirmAndCancel({ post, onCancel, t });
      if (cancelled) {
        onCancelled();
      }
    } finally {
      setIsCancelling(false);
    }
  }, [onCancel, onCancelled, post, t]);

  return (
    <View className="flex-1">
      <View className="flex-row items-center gap-2 px-4 py-3 border-b border-border">
        <TouchableOpacity
          onPress={onBack}
          hitSlop={HIT_SLOP_LG}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={t('common.back', { defaultValue: 'Back' })}
        >
          <Ionicons name="chevron-back" size={22} color={theme.colors.text} />
        </TouchableOpacity>
        <View className="flex-1">
          <Text className="text-base font-semibold text-foreground">
            {t('compose.scheduled.previewTitle', { defaultValue: 'Preview' })}
          </Text>
          <View className="flex-row items-center gap-1.5 mt-0.5">
            <CalendarIcon size={12} color={theme.colors.textSecondary} />
            <Text className="text-xs text-muted-foreground">
              {publishAt === null
                ? t('compose.scheduled.unknownTime', { defaultValue: 'Time unavailable' })
                : pastDue
                  ? t('compose.scheduled.publishing', { defaultValue: 'Publishing now…' })
                  : t('compose.scheduled.publishesAt', {
                      defaultValue: 'Publishes {{time}}',
                      time: formatScheduledLabel(publishAt),
                    })}
            </Text>
          </View>
        </View>
      </View>

      {pastDue && (
        <View className="px-4 py-2 bg-secondary border-b border-border">
          <Text className="text-xs text-muted-foreground">
            {t('compose.scheduled.pastDueNotice', {
              defaultValue: 'Its time has passed — it may already be live. Reopen this list to refresh.',
            })}
          </Text>
        </View>
      )}

      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        {/*
          Inert on purpose — see the component doc. The wrapper carries no
          styling of its own so the post renders at exactly its feed width.
        */}
        <View pointerEvents="none">
          <PostItem post={post} />
        </View>
      </ScrollView>

      <View className="flex-row items-center gap-2 px-4 py-3 border-t border-border">
        <TouchableOpacity
          className="flex-1 flex-row items-center justify-center gap-2 py-3 rounded-full bg-secondary"
          onPress={onEdit}
          disabled={isCancelling}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={t('compose.scheduled.edit', { defaultValue: 'Edit scheduled post' })}
        >
          <Ionicons name="create-outline" size={16} color={theme.colors.text} />
          <Text className="text-sm font-semibold text-foreground">
            {t('common.edit', { defaultValue: 'Edit' })}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          className="flex-1 flex-row items-center justify-center gap-2 py-3 rounded-full"
          style={{ backgroundColor: `${theme.colors.error}1A` }}
          onPress={handleCancel}
          disabled={isCancelling}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={t('compose.scheduled.cancelTitle', { defaultValue: 'Cancel scheduled post' })}
        >
          {isCancelling ? (
            <Loading className="text-primary" variant="inline" size="small" style={{ flex: undefined }} />
          ) : (
            <Ionicons name="trash-outline" size={16} color={theme.colors.error} />
          )}
          <Text className="text-sm font-semibold" style={{ color: theme.colors.error }}>
            {t('common.cancel')}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

export default ScheduledPostPreview;
