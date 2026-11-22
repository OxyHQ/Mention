import type React from 'react';
import { useMemo } from 'react';
import { RiEditLine } from '@oxy.so/bloom/icons/RiEditLine';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';
import type { PostUser } from '@mention/shared-types';
import { usePrivateMediaUrls } from '@/hooks/usePrivateMediaUrls';
import { getNormalizedUserHandle } from '@oxy.so/core';
import type { Draft } from '@/hooks/useDrafts';
import { draftToPreviewPost } from '@/utils/draftPreview';
import PostPreviewSurface from './PostPreviewSurface';

import {
  Button as LButton,
  Icon,
  RawText,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

interface DraftPreviewProps {
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

  const author = useMemo<PostUser>(
    () => ({
      id: user?.id ?? '',
      username: getNormalizedUserHandle(user) ?? '',
      name: { displayName: user?.name?.displayName },
      avatar: user?.avatar,
    }),
    [user],
  );

  const resolveMediaUrl = usePrivateMediaUrls(
    [
      ...draft.mediaIds.map((item) => item.id),
      ...(draft.languages?.languages.flatMap((language) =>
        language.items.flatMap((item) => item.media?.map((media) => media.id) ?? []),
      ) ?? []),
    ].map((fileId) => ({ fileId })),
  );

  const { post, remainingThreadItems } = useMemo(
    () =>
      draftToPreviewPost({
        draft,
        author,
        resolveMediaUrl,
      }),
    [draft, author, resolveMediaUrl],
  );

  return (
    <PostPreviewSurface
      post={post}
      title={t('compose.draftPreviewTitle', { defaultValue: 'Draft preview' })}
      subtitle={
        remainingThreadItems > 0
          ? toElement(
              RawText(
                t('compose.draftPreviewThread', {
                  defaultValue: 'First post of {{count}} more in this thread',
                  count: remainingThreadItems,
                }),
              )
                .font('xs')
                .leading('16px')
                .foreground('muted')
                .margin('top', '2xs'),
            )
          : undefined
      }
      onBack={onBack}
    >
      {toElement(
        VStack(
          LButton(
            Icon(RiEditLine),
            LText(t('compose.draftPreviewEdit', { defaultValue: 'Continue writing' })),
          )
            .size('lg')
            .onPress(onEdit),
        )
          .padding('horizontal', 'lg')
          .padding('vertical', 'md')
          .border('border', 'thin', 'top'),
      )}
    </PostPreviewSurface>
  );
};

export default DraftPreview;
