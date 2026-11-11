import { Screen } from '@oxy.so/bloom/screen';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useTranslation } from 'react-i18next';
import Feed from '@/components/Feed/Feed';
import { InlineReplyComposer } from './InlineReplyComposer';
import type { VideoReplyDraft } from './videoReplyDraft';

export interface VideoRepliesProps {
  postId: string;
  /** Called after a reply successfully posts — see InlineReplyComposer. */
  onCommentPosted?: () => void;
  focusComposerNonce?: number;
  draft?: VideoReplyDraft;
}

/**
 * One replies list and composer in the originating video's Bloom group.
 * Bloom presents the same screen inline or in its responsive floating surface.
 * Bloom owns chrome and scroll; Feed virtualizes against that same viewport.
 */
const NOOP = () => {};

export function VideoReplies({
  postId,
  onCommentPosted = NOOP,
  focusComposerNonce = 0,
  draft,
}: VideoRepliesProps) {
  const { t } = useTranslation();

  return (
    <Screen
      scroll="auto"
      testID="video-replies-screen"
      header={<PageHeader title={t('videos.replies')} onBack={null} safeArea={false} />}
      bottomBar={
        <InlineReplyComposer
          postId={postId}
          onPosted={onCommentPosted}
          focusNonce={focusComposerNonce}
          draft={draft}
        />
      }
    >
      <Feed type="replies" filters={{ postId, parentPostId: postId }} hideHeader />
    </Screen>
  );
}
