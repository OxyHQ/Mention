import { Screen } from '@oxy.so/bloom/screen';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { IconButton } from '@oxy.so/bloom/button';
import { useTranslation } from 'react-i18next';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import Feed from '@/components/Feed/Feed';
import { useVideosRail } from '@/context/VideosRailContext';
import { InlineReplyComposer } from './InlineReplyComposer';

export interface VideoRepliesProps {
  postId: string;
  /**
   * Omitted on desktop — the replies column (RightBar) is always open and
   * cannot be dismissed. Only the mobile bottom sheet passes this to close
   * itself.
   */
  onClose?: () => void;
  /** Called after a reply successfully posts — see InlineReplyComposer. */
  onCommentPosted: () => void;
}

/**
 * Shared replies list + composer content, presented inside the mobile bottom
 * sheet (toggled by the on-video comment button) and the always-open desktop
 * replies column (rendered inside `RightBar`, next to the videos rail).
 * Bloom owns chrome and scroll; Feed virtualizes against that same viewport.
 */
export function VideoReplies({ postId, onClose, onCommentPosted }: VideoRepliesProps) {
  const { t } = useTranslation();
  // Desktop's on-video comment button opens nothing (this column is already
  // there) — it takes the caret instead. The mobile sheet never bumps the nonce,
  // so its composer is unaffected.
  const { focusComposerNonce } = useVideosRail();

  return (
    <Screen
      scroll="auto"
      documentScroll={onClose ? false : undefined}
      header={
        <PageHeader
          title={t('videos.replies')}
          actions={
            onClose ? (
              <IconButton
                leadingIcon={RiCloseLine}
                onPress={onClose}
                accessibilityLabel={t('common.close', { defaultValue: 'Close' })}
              />
            ) : undefined
          }
        />
      }
      bottomBar={
        <InlineReplyComposer
          postId={postId}
          onPosted={onCommentPosted}
          focusNonce={focusComposerNonce}
        />
      }
    >
      <Feed type="replies" filters={{ postId, parentPostId: postId }} hideHeader />
    </Screen>
  );
}
