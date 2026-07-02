import React, { useCallback, useState } from 'react';
import { View, TextInput, Pressable, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { Ionicons } from '@expo/vector-icons';
import { show as toast } from '@oxyhq/bloom/toast';
import { usePostsStore } from '@/stores/postsStore';

interface InlineReplyComposerProps {
  postId: string;
  /** Called after a reply successfully posts, so the caller can bump its own
   * local comment count (see Global Constraints — postsStore's optimistic
   * update does not reach the Videos screen's separate local state). */
  onPosted: () => void;
}

/**
 * Minimal, text-only reply composer for the inline comments panel/sheet.
 * Deliberately narrower than the full `/compose` screen (no media, mentions,
 * or hashtags) — matches Reels' plain-text comment box.
 */
export function InlineReplyComposer({ postId, onPosted }: InlineReplyComposerProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const createReply = usePostsStore((s) => s.createReply);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);

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
        value={text}
        onChangeText={setText}
        placeholder={t('videos.addComment', { defaultValue: 'Add a comment...' })}
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
