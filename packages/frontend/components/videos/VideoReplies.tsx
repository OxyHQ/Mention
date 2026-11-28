import { Button } from '@oxy.so/bloom/button';
import { useDialogContext } from '@oxy.so/bloom/dialog';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { PageFooter } from '@oxy.so/bloom/page-footer';
import { Screen } from '@oxy.so/bloom/screen';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useTranslation } from 'react-i18next';
import Feed from '@/components/Feed/Feed';
import { useAuth } from '@oxy.so/services/ui/client';
import { usePostSelector } from '@/stores/postsStore';
import { isPrivateMention, postAcceptsReplies } from '@/utils/postReplies';
import { CompactReplyComposer } from '@/components/Post/CompactReplyComposer';
import type { Href } from '@/lib/navigation/router';
import type { ReplyDraft } from '@/components/Post/replyDraft';

export interface VideoRepliesProps {
  postId: string;
  focusComposerNonce?: number;
  draft?: ReplyDraft;
  onClose?: () => void;
  onNavigate?: (href: Href) => void;
}

/**
 * One replies list and composer in the originating video's Bloom group.
 * Bloom presents the same screen inline or in its responsive floating surface.
 * Bloom owns chrome and scroll; Feed virtualizes against that same viewport.
 */
export function VideoReplies({
  postId,
  focusComposerNonce = 0,
  draft,
  onClose,
  onNavigate,
}: VideoRepliesProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { isWithinDialog } = useDialogContext();
  const post = usePostSelector(postId);

  return (
    <Screen
      scroll="auto"
      testID="video-replies-screen"
      bottomBarKeyboardBehavior="follow"
      header={
        <PageHeader
          title={t('videos.replies')}
          onBack={null}
          safeArea={false}
          actions={
            onClose && !isWithinDialog ? (
              <Button
                appearance="subtle"
                tone="neutral"
                iconOnly
                leadingIcon={RiCloseLine}
                accessibilityLabel={t('common.close', { defaultValue: 'Close' })}
                onPress={onClose}
              />
            ) : undefined
          }
        />
      }
      bottomBar={
        user && postAcceptsReplies(post) ? (
          <PageFooter scrim="auto" contentContainerStyle={{ paddingLeft: 8, paddingRight: 8 }}>
            <CompactReplyComposer
              key={user.id}
              postId={postId}
              placeholder={
                isPrivateMention(post)
                  ? t('privateMentions.replyPlaceholder', { defaultValue: 'Reply privately' })
                  : undefined
              }
              focusNonce={focusComposerNonce}
              draft={draft}
              onNavigate={onNavigate}
            />
          </PageFooter>
        ) : undefined
      }
    >
      <Feed type="replies" filters={{ postId, parentPostId: postId }} hideHeader />
    </Screen>
  );
}
