import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, TextInput, Pressable, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import Ionicons from '@expo/vector-icons/Ionicons';
import { toast } from '@oxyhq/bloom/toast';
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
    <View style={styles.row} className="border-t border-border bg-background">
      <TextInput
        ref={inputRef}
        value={text}
        onChangeText={setText}
        placeholder={t('videos.addComment')}
        placeholderTextColor={theme.colors.textSecondary}
        style={[styles.input, { color: theme.colors.text }]}
        multiline
        maxLength={2000}
      />
      <Pressable
        onPress={handleSubmit}
        disabled={!text.trim() || submitting}
        style={styles.sendButton}
        accessibilityRole="button"
        accessibilityLabel={t('common.send', { defaultValue: 'Send' })}
      >
        <Ionicons
          name="send"
          size={20}
          color={text.trim() && !submitting ? theme.colors.primary : theme.colors.textSecondary}
        />
      </Pressable>
    </View>
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
    fontSize: 15,
    maxHeight: 100,
    paddingVertical: 6,
  },
  sendButton: {
    paddingBottom: 6,
    paddingHorizontal: 4,
  },
});
