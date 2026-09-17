import React, { useMemo } from 'react';
import { View, Text } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { RiEditLine } from '@oxy.so/bloom/icons';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';
import type { PostUser } from '@mention/shared-types';
import { oxyServices } from '@/lib/oxyServices';
import { getNormalizedUserHandle } from '@oxy.so/core';
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
        <Button size="large" leadingIcon={RiEditLine} onPress={onEdit}>
          {t('compose.draftPreviewEdit', { defaultValue: 'Continue writing' })}
        </Button>
      </View>
    </PostPreviewSurface>
  );
};

export default DraftPreview;
