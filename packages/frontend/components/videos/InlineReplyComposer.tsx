import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Pressable, StyleSheet, type TextInput } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxy.so/bloom/theme';
import { Divider } from '@oxy.so/bloom/divider';
import { RiSendPlaneLine } from '@oxy.so/bloom/icons/RiSendPlaneLine';
import { useSurfaceFill } from '@oxy.so/bloom/styles';
import { Textarea } from '@oxy.so/bloom/textarea';
import { toast } from '@oxy.so/bloom/toast';
import { usePostsStore } from '@/stores/postsStore';

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
}

/**
 * Minimal, text-only reply composer for the inline comments panel/sheet.
 * Deliberately narrower than the full `/compose` screen (no media, mentions,
 * or hashtags) — matches Reels' plain-text comment box.
 */
export function InlineReplyComposer({ postId, onPosted, focusNonce = 0 }: InlineReplyComposerProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  // This composer is pinned under a scrolling reply list on TWO different
  // surfaces — the right rail's panel and the video-replies bottom sheet — so
  // the colour it has to be opaque in is not the same one in both. `bg-card`
  // was the rail's answer given in the sheet too.
  const surfaceFill = useSurfaceFill();
  const createReply = usePostsStore((s) => s.createReply);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<TextInput | null>(null);

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
    const trimmed = text.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await createReply({ postId, content: { text: trimmed } });
      setText('');
      onPosted();
    } catch {
      toast(t('common.error', { defaultValue: 'Something went wrong' }), { type: 'error' });
    } finally {
      setSubmitting(false);
    }
  }, [text, submitting, createReply, postId, onPosted, t]);

  return (
    <>
      <Divider />
      <View style={[styles.row, { backgroundColor: surfaceFill }]}>
        <Textarea
          inputRef={inputRef}
          value={text}
          onChangeText={setText}
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
