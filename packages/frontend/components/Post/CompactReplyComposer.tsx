import { COMPACT_REPLY_TEXT_LIMIT } from './compactReplyText';
import { ReplyComposerFocusContext } from './ReplyComposerFocusContext';
import {
  useContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  useId,
  useMemo,
  lazy,
  Suspense,
} from 'react';
import type { TextInputInstance } from 'react-native';
import { useTranslation } from 'react-i18next';
import { CompactComposer } from '@oxy.so/bloom/chat-composer';
import { MediaAttachmentIcon } from '@oxy.so/bloom/icons/MediaAttachmentIcon';
import { GifAttachmentIcon } from '@oxy.so/bloom/icons/GifAttachmentIcon';
import { useMediaPicker } from '@/hooks/useMediaPicker';
import { usePrivateMediaUrls } from '@/hooks/usePrivateMediaUrls';
import { presentSheet } from '@/utils/sheet';
import { ComposeMediaPreview } from '@/components/Compose/ComposeMediaPreview';
import AttachmentCarouselItem from '@/components/Compose/AttachmentCarouselItem';
import { ScrollArea } from '@oxy.so/bloom/layout';
import { useAuth, useAuthStore } from '@oxy.so/services/ui/client';
import { useRouter, useFocusEffect, type Href } from '@/lib/navigation/router';
import {
  createReplyComposerHandoff,
  discardReplyComposerHandoff,
} from '@/utils/replyComposerHandoff';
import { AccountAvatar } from '@/components/ui/AccountAvatar';
import { toast } from '@oxy.so/bloom/toast';
import { logger } from '@oxy.so/core/logger';
import { usePostsStore } from '@/stores/postsStore';
import { usePublicationContinuation } from '@/hooks/usePublicationContinuation';
import { useStore } from 'zustand';
import { createReplyDraft, type ReplyDraft } from '@/components/Post/replyDraft';

const GifPickerSheet = lazy(() => import('@/components/Compose/GifPickerSheet'));

interface CompactReplyComposerProps {
  postId: string;
  /** Optional owner continuation; post/feed caches are already updated by createReply. */
  onPosted?: () => void;
  placeholder?: string;
  onNavigate?: (href: Href) => void;
  /**
   * A CHANGE in this value takes the caret. Deliberately not a boolean: the
   * desktop comment button can be pressed twice in a row for the same video, and
   * both presses have to land.
   */
  focusNonce?: number;
  draft?: ReplyDraft;
}

/**
 * Shared compact reply composer for post details and supporting panels.
 * Full editing uses the same reply target through the existing Compose route.
 */
export function CompactReplyComposer({
  postId,
  onPosted,
  focusNonce = 0,
  draft,
  placeholder,
  onNavigate,
}: CompactReplyComposerProps) {
  const { t } = useTranslation();
  const { user, oxyServices, showBottomSheet } = useAuth();
  const router = useRouter();
  const sourceId = useId();
  const createReply = usePostsStore((s) => s.createReply);
  const [localDraft] = useState(() => draft ?? createReplyDraft());
  const replyDraft = draft ?? localDraft;
  const text = useStore(replyDraft.store, (state) => state.text);
  const mediaIds = useStore(replyDraft.store, (state) => state.mediaIds);
  const mediaRequests = useMemo(() => mediaIds.map((item) => ({ fileId: item.id })), [mediaIds]);
  const mediaUrl = usePrivateMediaUrls(mediaRequests);
  const { openMediaPicker } = useMediaPicker({ showBottomSheet, t });
  const submitting = useStore(replyDraft.store, (state) => state.pending !== null);
  const { capture } = usePublicationContinuation(replyDraft.isCurrent);
  const inputRef = useRef<TextInputInstance | null>(null);
  const footerFocus = useContext(ReplyComposerFocusContext);
  const transferringRef = useRef(false);
  const [transferring, setTransferring] = useState(false);
  useFocusEffect(
    useCallback(() => {
      transferringRef.current = false;
      setTransferring(false);
    }, []),
  );

  // Only a change taken while this composer was mounted counts. Seeding the ref
  // with the value at mount is what stops a remount — leaving /videos and coming
  // back — from stealing the caret on a nonce raised by a press long gone.
  const handledFocusNonceRef = useRef(focusNonce);
  useEffect(() => {
    if (handledFocusNonceRef.current === focusNonce) return;
    handledFocusNonceRef.current = focusNonce;
    inputRef.current?.focus();
  }, [focusNonce]);

  const handleSubmit = useCallback(async () => {
    const current = replyDraft.store.getState();
    const isCurrentOwner = capture();
    if (
      (!current.text.trim() && !current.mediaIds.length) ||
      current.pending ||
      current.text.length > COMPACT_REPLY_TEXT_LIMIT ||
      transferringRef.current
    )
      return;
    if (!isCurrentOwner) {
      toast(t('common.error', { defaultValue: 'Something went wrong' }), { type: 'error' });
      return;
    }
    const operation = current.begin();
    if (!operation) return;
    let confirmed = false;
    const warnUnconfirmed = () =>
      toast(
        t('compose.replyUnconfirmed', {
          defaultValue: 'Could not confirm your reply. Check the conversation before trying again.',
        }),
        { type: 'error' },
      );
    try {
      await createReply({
        postId,
        content: {
          text: operation.text,
          ...(operation.mediaIds.length ? { media: operation.mediaIds } : {}),
        },
      });
      confirmed = true;
      if (!isCurrentOwner()) {
        if (capture()) warnUnconfirmed();
        return;
      }
      replyDraft.store.getState().clearIfUnchanged(operation.revision);
      onPosted?.();
    } catch (error) {
      if (confirmed) {
        logger.error('Reply posted, but updating the conversation failed', error);
      } else if (isCurrentOwner() || capture()) {
        warnUnconfirmed();
      }
    } finally {
      replyDraft.store.getState().finish(operation.id);
    }
  }, [replyDraft, createReply, postId, onPosted, t, capture]);

  const openImages = () => {
    const owner = capture();
    if (!owner || submitting || transferringRef.current) return;
    openMediaPicker((items) => {
      if (owner() && !transferringRef.current) replyDraft.store.getState().addMedia(items);
    });
  };
  const openGifs = () => {
    const owner = capture();
    if (!owner || submitting || transferringRef.current) return;
    void presentSheet((surface) => (
      <Suspense fallback={null}>
        <GifPickerSheet
          onClose={() => surface.dismiss()}
          onSelectGif={async (_url, id) => {
            if (owner() && !transferringRef.current)
              replyDraft.store.getState().addMedia([{ id, type: 'gif' }]);
          }}
        />
      </Suspense>
    ));
  };
  const handleExpand = () => {
    const current = replyDraft.store.getState();
    if (current.pending || transferringRef.current || !capture() || !user) return;
    const scope = {
      viewerId: user.id,
      epoch: oxyServices.http.getSessionEpoch(),
      replyToPostId: postId,
    };
    const token = createReplyComposerHandoff({
      ...scope,
      sourceId,
      text: current.text,
      mediaIds: current.mediaIds,
      revision: current.revision,
      onClaim: () => {
        if (
          transferringRef.current &&
          useAuthStore.getState().user?.id === scope.viewerId &&
          oxyServices.http.getSessionEpoch() === scope.epoch
        ) {
          replyDraft.store.getState().clearIfUnchanged(current.revision);
        }
      },
    });
    if (!token) return;
    transferringRef.current = true;
    setTransferring(true);
    try {
      (onNavigate ?? router.push)(
        `/compose?replyToPostId=${encodeURIComponent(postId)}&replyDraftToken=${encodeURIComponent(token)}`,
      );
    } catch (error) {
      discardReplyComposerHandoff(token, scope);
      transferringRef.current = false;
      setTransferring(false);
      throw error;
    }
  };

  return (
    <CompactComposer
      testID="compact-reply"
      value={text}
      onChangeText={(next) => replyDraft.store.getState().setText(next)}
      maxLength={COMPACT_REPLY_TEXT_LIMIT}
      inputRef={inputRef}
      avatar={
        <AccountAvatar account={user ?? undefined} source={user?.avatar || undefined} size={32} />
      }
      attachments={
        mediaIds.length ? (
          <ScrollArea
            horizontal
            style={{ height: 72 }}
            contentContainerStyle={{ gap: 8, paddingBottom: 8 }}
          >
            {mediaIds.map((item, index) => (
              <AttachmentCarouselItem
                key={item.id}
                attachmentKey={item.id}
                index={index}
                total={mediaIds.length}
                onMove={(index, direction) =>
                  replyDraft.store.getState().moveMedia(index, direction)
                }
                onRemove={() => replyDraft.store.getState().removeMedia(item.id)}
                wrapperStyle={{ width: 64, height: 64, borderRadius: 8, overflow: 'hidden' }}
              >
                {mediaUrl(item.id) ? (
                  <ComposeMediaPreview
                    type={item.type}
                    uri={mediaUrl(item.id)}
                    imageStyle={{ width: 64, height: 64 }}
                  />
                ) : null}
              </AttachmentCarouselItem>
            ))}
          </ScrollArea>
        ) : null
      }
      attachmentActions={[
        {
          id: 'media',
          icon: MediaAttachmentIcon,
          label: t('compose.toolbar.media'),
          onPress: openImages,
          testID: 'compact-reply-image',
        },
        {
          id: 'gif',
          icon: GifAttachmentIcon,
          label: t('compose.toolbar.gif'),
          onPress: openGifs,
          testID: 'compact-reply-gif',
        },
      ]}
      onExpand={handleExpand}
      onSubmit={handleSubmit}
      onFocusChange={footerFocus?.setFocused}
      disabled={transferring}
      busy={submitting}
      placeholder={
        placeholder ?? t('compose.replyPlaceholder', { defaultValue: 'Post your reply' })
      }
      labels={{
        input: placeholder ?? t('compose.replyPlaceholder', { defaultValue: 'Post your reply' }),
        expand: t('compose.expand', { defaultValue: 'Open full composer' }),
        submit: t('common.reply'),
        limitHint: t('compose.compactLimitHint', {
          max: COMPACT_REPLY_TEXT_LIMIT,
          defaultValue: 'Compact replies allow {{max}} characters. Expand to write more.',
        }),
        characterCount: t('compose.characterCountLabel', { defaultValue: 'Characters' }),
        characterCountValue: (count, max) =>
          t('compose.characterCountValue', {
            count,
            max,
            defaultValue: '{{count}} of {{max}} characters',
          }),
      }}
    />
  );
}
