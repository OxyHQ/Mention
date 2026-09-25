import React, { useCallback, useState } from 'react';
import { View, Text } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { RiCloudLine } from '@oxy.so/bloom/icons/RiCloudLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiEditLine } from '@oxy.so/bloom/icons/RiEditLine';
import { RiSendPlaneLine } from '@oxy.so/bloom/icons/RiSendPlaneLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
import type { HydratedPost } from '@mention/shared-types';
import PostPreviewSurface from './PostPreviewSurface';
import { confirmAndDeleteServerDraft, confirmAndPublishDraft, otherDraftLanguages } from './serverDraftActions';

export interface ServerDraftPreviewProps {
  post: HydratedPost;
  onBack: () => void;
  /** Open the previewed draft in the composer. */
  onEdit: () => void;
  /** Publish the previewed draft. Rejects when the server refuses. */
  onPublish: (postId: string) => Promise<void>;
  /** Delete the previewed draft. Rejects when the server refuses. */
  onDelete: (postId: string) => Promise<void>;
  /** Called after the draft left the list (published or deleted). */
  onDone: () => void;
}

/**
 * How a server draft will look once published — the last look before approving
 * something an automation wrote.
 *
 * The same `PostPreviewSurface` the scheduled and local-draft previews render
 * through, with this draft's own actions: publish is the primary one, because
 * approving is what the person came here to do.
 */
const ServerDraftPreview: React.FC<ServerDraftPreviewProps> = ({
  post,
  onBack,
  onEdit,
  onPublish,
  onDelete,
  onDone,
}) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const [isPublishing, setIsPublishing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const busy = isPublishing || isDeleting;
  const otherLanguages = otherDraftLanguages(post);

  const handlePublish = useCallback(async () => {
    setIsPublishing(true);
    try {
      if (await confirmAndPublishDraft({ post, onPublish, t })) onDone();
    } finally {
      setIsPublishing(false);
    }
  }, [onDone, onPublish, post, t]);

  const handleDelete = useCallback(async () => {
    setIsDeleting(true);
    try {
      if (await confirmAndDeleteServerDraft({ post, onDelete, t })) onDone();
    } finally {
      setIsDeleting(false);
    }
  }, [onDelete, onDone, post, t]);

  return (
    <PostPreviewSurface
      post={post}
      title={t('compose.draftPreviewTitle', { defaultValue: 'Draft preview' })}
      subtitle={(
        <View className="flex-row items-center gap-1.5 mt-0.5">
          <RiCloudLine size="xs" fill={theme.colors.textSecondary} />
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {otherLanguages.length > 0
              ? t('compose.serverDrafts.savedAlsoIn', {
                  defaultValue: 'Saved to your account · also in {{languages}}',
                  languages: otherLanguages.join(', '),
                })
              : t('compose.serverDrafts.title', { defaultValue: 'Saved to your account' })}
          </Text>
        </View>
      )}
      onBack={onBack}
    >
      <View className="px-4 pt-3 border-t border-border">
        <Button
          size="large"
          leadingIcon={RiSendPlaneLine}
          onPress={handlePublish}
          disabled={busy}
          loading={isPublishing}
          accessibilityLabel={t('compose.serverDrafts.publishTitle', { defaultValue: 'Publish draft' })}
        >
          {t('compose.serverDrafts.publish', { defaultValue: 'Publish' })}
        </Button>
      </View>

      <View className="flex-row items-center gap-2 px-4 py-3">
        <Button
          className="flex-1"
          appearance="subtle" tone="neutral"
          size="large"
          leadingIcon={RiEditLine}
          onPress={onEdit}
          disabled={busy}
          accessibilityLabel={t('compose.serverDrafts.edit', { defaultValue: 'Edit draft' })}
        >
          {t('common.edit', { defaultValue: 'Edit' })}
        </Button>
        <Button
          className="flex-1"
          appearance="solid" tone="danger"
          size="large"
          leadingIcon={RiDeleteBinLine}
          onPress={handleDelete}
          disabled={busy}
          loading={isDeleting}
          accessibilityLabel={t('compose.deleteDraft')}
        >
          {t('common.delete')}
        </Button>
      </View>
    </PostPreviewSurface>
  );
};

export default ServerDraftPreview;
