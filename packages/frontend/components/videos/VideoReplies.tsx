import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import Ionicons from '@expo/vector-icons/Ionicons';
// This panel owns an element-sized scroller, including on web. Use the
// FlashList implementation explicitly instead of the document-scroll web feed.
import Feed from '@/components/Feed/Feed.native';
import { useVideosRail } from '@/context/VideosRailContext';
import { InlineReplyComposer } from './InlineReplyComposer';

interface VideoRepliesProps {
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
 * It is the sole scroll owner and uses FlashList on both platforms, keeping
 * mounted reply rows bounded to the panel viewport.
 */
export function VideoReplies({ postId, onClose, onCommentPosted }: VideoRepliesProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  // Desktop's on-video comment button opens nothing (this column is already
  // there) — it takes the caret instead. The mobile sheet never bumps the nonce,
  // so its composer is unaffected.
  const { focusComposerNonce } = useVideosRail();

  return (
    <View style={styles.container}>
      <View style={styles.header} className="border-b border-border">
        <Text style={[styles.title, { color: theme.colors.text }]}>
          {t('videos.replies')}
        </Text>
        {onClose && (
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={t('common.close', { defaultValue: 'Close' })}>
            <Ionicons name="close" size={22} color={theme.colors.text} />
          </Pressable>
        )}
      </View>

      <View style={styles.list}>
        <Feed
          type="replies"
          filters={{ postId, parentPostId: postId }}
          scrollEnabled
          hideHeader
          style={styles.list}
        />
      </View>

      <InlineReplyComposer
        postId={postId}
        onPosted={onCommentPosted}
        focusNonce={focusComposerNonce}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
  },
  list: {
    flex: 1,
  },
});
