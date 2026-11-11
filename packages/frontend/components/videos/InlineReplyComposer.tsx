import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Pressable, StyleSheet, type TextInputInstance } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxy.so/bloom/theme';
import { Divider } from '@oxy.so/bloom/divider';
import { RiSendPlaneLine } from '@oxy.so/bloom/icons/RiSendPlaneLine';
import { useSurfaceFill } from '@oxy.so/bloom/styles';
import { Textarea } from '@oxy.so/bloom/textarea';
import { toast } from '@oxy.so/bloom/toast';
import { logger } from '@oxy.so/core/logger';
import { usePostsStore } from '@/stores/postsStore';
import { usePublicationContinuation } from '@/hooks/usePublicationContinuation';
import { useStore } from 'zustand';
import { createVideoReplyDraft, type VideoReplyDraft } from './videoReplyDraft';

interface InlineReplyComposerProps {
  postId: string;
  /** Called after a reply successfully posts, so the caller can bump its own
   * local comment count (see Global Constraints — postsStore's optimistic
   * update does not reach the Videos screen's separate local state). */
  onPosted: () => void;
  /**
   * A CHANGE in this value takes the caret. Deliberately not a boolean: the
   * desktop comment button can be pressed twice in a row for the same video, and
   * both presses have to land.
   */
  focusNonce?: number;
  draft?: VideoReplyDraft;
}

/**
 * Minimal, text-only reply composer for the inline comments panel/sheet.
 * Deliberately narrower than the full `/compose` screen (no media, mentions,
 * or hashtags) — matches Reels' plain-text comment box.
 */
export function InlineReplyComposer({
  postId,
  onPosted,
  focusNonce = 0,
  draft,
}: InlineReplyComposerProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  // The shared panel or floating surface owns the opaque composer fill.
  const surfaceFill = useSurfaceFill();
  const createReply = usePostsStore((s) => s.createReply);
  const [localDraft] = useState(() => draft ?? createVideoReplyDraft());
  const replyDraft = draft ?? localDraft;
  const text = useStore(replyDraft.store, (state) => state.text);
  const submitting = useStore(replyDraft.store, (state) => state.pending !== null);
  const { capture } = usePublicationContinuation(replyDraft.isCurrent);
  const inputRef = useRef<TextInputInstance | null>(null);

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
    if (!current.text.trim() || current.pending) return;
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
      await createReply({ postId, content: { text: operation.text } });
      confirmed = true;
      if (!isCurrentOwner()) {
        if (capture()) warnUnconfirmed();
        return;
      }
      replyDraft.store.getState().clearIfUnchanged(operation.revision);
      onPosted();
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

  return (
    <>
      <Divider />
      <View style={[styles.row, { backgroundColor: surfaceFill }]}>
        <Textarea
          inputRef={inputRef}
          value={text}
          onChangeText={replyDraft.store.getState().setText}
          placeholder={t('videos.addComment')}
          size="sm"
          rows={1}
          autoResize
          maxRows={5}
          maxLength={2000}
          style={styles.input}
        />
        <Pressable
          onPress={handleSubmit}
          disabled={!text.trim() || submitting}
          style={styles.sendButton}
          accessibilityRole="button"
          accessibilityLabel={t('common.send', { defaultValue: 'Send' })}
        >
          <RiSendPlaneLine
            size="md"
            fill={text.trim() && !submitting ? theme.colors.primary : theme.colors.textSecondary}
          />
        </Pressable>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  input: {
    flex: 1,
  },
  sendButton: {
    paddingBottom: 8,
    paddingHorizontal: 4,
  },
});
