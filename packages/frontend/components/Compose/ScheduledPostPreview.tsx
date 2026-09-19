import React, { useCallback, useState } from 'react';
import { View, Text } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { RiCalendarLine } from '@oxy.so/bloom/icons/RiCalendarLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiEditLine } from '@oxy.so/bloom/icons/RiEditLine';
import { RiSendPlaneLine } from '@oxy.so/bloom/icons/RiSendPlaneLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
import type { HydratedPost } from '@mention/shared-types';
import { isPastDue, scheduledDate } from '@/utils/postSchedule';
import PostPreviewSurface from './PostPreviewSurface';
import { confirmAndCancel } from './ScheduledPostsList';
import { confirmDialog } from '@/utils/alerts';
import { toast } from '@oxy.so/bloom/toast';
import { createLogger } from '@oxy.so/core/logger';
import { formatScheduledLabel } from '@/utils/dateUtils';

const logger = createLogger('ScheduledPostPreview');

export interface ScheduledPostPreviewProps {
  post: HydratedPost;
  onBack: () => void;
  /** Load the previewed post back into the composer. */
  onEdit: () => void;
  /** Publish the previewed post immediately. Rejects when the server refuses. */
  onPublishNow: (postId: string) => Promise<void>;
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
  onPublishNow,
  onCancel,
  onCancelled,
}) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const [isCancelling, setIsCancelling] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const busy = isCancelling || isPublishing;

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

  /**
   * Publishing early is a one-way, PUBLIC action — it federates and notifies —
   * so it asks first, like cancelling does. The wording says what changes:
   * the post goes out now instead of at the time that was chosen.
   */
  const handlePublishNow = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t('compose.scheduled.publishNow', { defaultValue: 'Post now' }),
      message: t('compose.scheduled.publishNowConfirm', {
        defaultValue: 'This post goes out immediately instead of at its scheduled time.',
      }),
      okText: t('compose.scheduled.publishNow', { defaultValue: 'Post now' }),
      cancelText: t('common.cancel'),
    });
    if (!confirmed) return;

    setIsPublishing(true);
    try {
      await onPublishNow(post.id);
      toast(t('compose.scheduled.published', { defaultValue: 'Post published' }), { type: 'success' });
      onCancelled();
    } catch (error) {
      logger.error('Error publishing a scheduled post early', error);
      toast(t('compose.scheduled.publishError', { defaultValue: 'Could not publish the post' }), { type: 'error' });
    } finally {
      setIsPublishing(false);
    }
  }, [onCancelled, onPublishNow, post.id, t]);

  return (
    <PostPreviewSurface
      post={post}
      title={t('compose.scheduled.previewTitle', { defaultValue: 'Preview' })}
      subtitle={(
        <View className="flex-row items-center gap-1.5 mt-0.5">
          <RiCalendarLine size="xs" fill={theme.colors.textSecondary} />
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
      )}
      notice={pastDue ? (
        <View className="px-4 py-2 bg-muted border-b border-border">
          <Text className="text-xs text-muted-foreground">
            {t('compose.scheduled.pastDueNotice', {
              defaultValue: 'Its time has passed — it may already be live. Reopen this list to refresh.',
            })}
          </Text>
        </View>
      ) : undefined}
      onBack={onBack}
    >
      <View className="px-4 pt-3 border-t border-border">
        <Button
          size="large"
          leadingIcon={RiSendPlaneLine}
          onPress={handlePublishNow}
          disabled={busy}
          loading={isPublishing}
          accessibilityLabel={t('compose.scheduled.publishNow', { defaultValue: 'Post now' })}
        >
          {t('compose.scheduled.publishNow', { defaultValue: 'Post now' })}
        </Button>
      </View>

      <View className="flex-row items-center gap-2 px-4 py-3">
        <Button
          className="flex-1"
          variant="secondary"
          size="large"
          leadingIcon={RiEditLine}
          onPress={onEdit}
          disabled={busy}
          accessibilityLabel={t('compose.scheduled.edit', { defaultValue: 'Edit scheduled post' })}
        >
          {t('common.edit', { defaultValue: 'Edit' })}
        </Button>
        <Button
          className="flex-1"
          variant="destructive"
          size="large"
          leadingIcon={RiDeleteBinLine}
          onPress={handleCancel}
          disabled={busy}
          loading={isCancelling}
          accessibilityLabel={t('compose.scheduled.cancelTitle', { defaultValue: 'Cancel scheduled post' })}
        >
          {t('common.cancel')}
        </Button>
      </View>
    </PostPreviewSurface>
  );
};

export default ScheduledPostPreview;
