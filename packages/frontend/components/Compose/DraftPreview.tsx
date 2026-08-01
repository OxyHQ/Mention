import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxyhq/services/ui/client';
import type { PostUser } from '@mention/shared-types';
import { oxyServices } from '@/lib/oxyServices';
import { getNormalizedUserHandle } from '@oxyhq/core';
import type { Draft } from '@/hooks/useDrafts';
import { draftToPreviewPost } from '@/utils/draftPreview';
import PostPreviewSurface from './PostPreviewSurface';

export interface DraftPreviewProps {
  draft: Draft;
  onBack: () => void;
  /** Open this draft in the composer. */
  onEdit: () => void;
}

/**
 * How a local draft will look once it is posted.
 *
 * The same surface a scheduled post previews on — deliberately, because "what
 * will this look like" has one right answer. What differs is where the DTO comes
 * from: a scheduled post is hydrated server-side, whereas a draft has never been
 * near the server, so `draftToPreviewPost` builds one from the draft plus the
 * viewer's own identity (the viewer IS the author) and the app's canonical media
 * chokepoint.
 *
 * A thread draft previews its FIRST post and says how many follow. Rendering one
 * post of a thread without saying so would misrepresent the draft, and rendering
 * the whole thread is a different surface from the one this shares.
 */
const DraftPreview: React.FC<DraftPreviewProps> = ({ draft, onBack, onEdit }) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const { user } = useAuth();

  const author = useMemo<PostUser>(() => ({
    id: user?.id ?? '',
    username: getNormalizedUserHandle(user) ?? '',
    name: { displayName: user?.name?.displayName },
    avatar: user?.avatar,
  }), [user]);

  const { post, remainingThreadItems } = useMemo(
    () => draftToPreviewPost({
      draft,
      author,
      resolveMediaUrl: (fileId) => oxyServices.getFileDownloadUrl(fileId),
    }),
    [draft, author],
  );

  return (
    <PostPreviewSurface
      post={post}
      title={t('compose.draftPreviewTitle', { defaultValue: 'Draft preview' })}
      subtitle={remainingThreadItems > 0 ? (
        <Text className="text-xs text-muted-foreground mt-0.5">
          {t('compose.draftPreviewThread', {
            defaultValue: 'First post of {{count}} more in this thread',
            count: remainingThreadItems,
          })}
        </Text>
      ) : undefined}
      onBack={onBack}
    >
      <View className="px-4 py-3 border-t border-border">
        <TouchableOpacity
          className="flex-row items-center justify-center gap-2 py-3 rounded-full bg-primary"
          onPress={onEdit}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={t('compose.draftPreviewEdit', { defaultValue: 'Continue writing' })}
        >
          <Ionicons name="create-outline" size={16} color={theme.colors.card} />
          <Text className="text-sm font-semibold" style={{ color: theme.colors.card }}>
            {t('compose.draftPreviewEdit', { defaultValue: 'Continue writing' })}
          </Text>
        </TouchableOpacity>
      </View>
    </PostPreviewSurface>
  );
};

export default DraftPreview;
