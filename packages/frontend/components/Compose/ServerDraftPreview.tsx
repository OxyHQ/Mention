import type React from 'react';
import { useCallback, useState } from 'react';

import { RiCloudLine } from '@oxy.so/bloom/icons/RiCloudLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiEditLine } from '@oxy.so/bloom/icons/RiEditLine';
import { RiSendPlaneLine } from '@oxy.so/bloom/icons/RiSendPlaneLine';
import { useTranslation } from 'react-i18next';
import type { HydratedPost } from '@mention/shared-types';
import PostPreviewSurface from './PostPreviewSurface';
import {
  confirmAndDeleteServerDraft,
  confirmAndPublishDraft,
  otherDraftLanguages,
} from './serverDraftActions';
import {
  Button as LButton,
  HStack,
  Icon,
  RawText,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

interface ServerDraftPreviewProps {
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
      subtitle={HStack(
        Icon(RiCloudLine).size('xs').foreground('muted'),
        RawText(
          otherLanguages.length > 0
            ? t('compose.serverDrafts.savedAlsoIn', {
                defaultValue: 'Saved to your account · also in {{languages}}',
                languages: otherLanguages.join(', '),
              })
            : t('compose.serverDrafts.title', { defaultValue: 'Saved to your account' }),
        )
          .font('xs')
          .leading('16px')
          .foreground('muted')
          .lines(1),
      )
        .align('center')
        .spacing('6')
        .margin('top', '2xs')}
      onBack={onBack}
    >
      {toElement(
        VStack(
          LButton(
            Icon(RiSendPlaneLine),
            LText(t('compose.serverDrafts.publish', { defaultValue: 'Publish' })),
          )
            .size('lg')
            .onPress(handlePublish)
            .disabled(busy)
            .loading(isPublishing)
            .label(
              t('compose.serverDrafts.publishTitle', {
                defaultValue: 'Publish draft',
              }),
            ),
        )
          .padding('horizontal', 'lg')
          .padding('top', 'md')
          .border('border', 'thin', 'top'),
      )}
      {toElement(
        HStack(
          LButton(Icon(RiEditLine), LText(t('common.edit', { defaultValue: 'Edit' })))
            .style('subtle')
            .tint('neutral')
            .size('lg')
            .onPress(onEdit)
            .disabled(busy)
            .label(t('compose.serverDrafts.edit', { defaultValue: 'Edit draft' }))
            .flex('1'),
          LButton(Icon(RiDeleteBinLine), LText(t('common.delete')))
            .style('solid')
            .tint('danger')
            .size('lg')
            .onPress(handleDelete)
            .disabled(busy)
            .loading(isDeleting)
            .label(t('compose.deleteDraft'))
            .flex('1'),
        )
          .padding('horizontal', 'lg')
          .padding('vertical', 'md')
          .align('center')
          .spacing('sm'),
      )}
    </PostPreviewSurface>
  );
};

export default ServerDraftPreview;
