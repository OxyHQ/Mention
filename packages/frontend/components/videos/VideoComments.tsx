import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { Ionicons } from '@expo/vector-icons';
import Feed from '@/components/Feed/Feed';
import { InlineReplyComposer } from './InlineReplyComposer';

interface VideoCommentsProps {
  postId: string;
  onClose: () => void;
  /** Called after a reply successfully posts — see InlineReplyComposer. */
  onCommentPosted: () => void;
}

/**
 * Shared comments list + composer content, presented inside the mobile
 * bottom sheet (Task 4) and the desktop right-panel (Task 5). Neither
 * consumer wraps this in a scrolling container of its own (the mobile sheet
 * is opened with `{ scrollable: false }` specifically so ITS content owns
 * scrolling — see `@oxyhq/bloom/bottom-sheet`'s `scrollable` prop doc; the
 * desktop `RightBar` branch is a plain `View` column), so this component owns
 * an internal `ScrollView` around the embedded `<Feed>`. The `<Feed>` itself
 * is embedded (`scrollEnabled={false}`) rather than scroll-owning: on both
 * platforms the embedded path renders every row as plain (non-virtualized)
 * content and composes inside a genuine scrolling ancestor rather than
 * scrolling itself (see `Feed.native.tsx`'s `NonScrollingScrollComponent` and
 * `Feed.web.tsx`'s `EmbeddedWebFeed` doc comments) — exactly mirroring how
 * `ProfileTabs` embeds the profile feed inside `ProfileScreen`'s own
 * `Animated.ScrollView`.
 */
export function VideoComments({ postId, onClose, onCommentPosted }: VideoCommentsProps) {
  const { t } = useTranslation();
  const theme = useTheme();

  return (
    <View style={styles.container}>
      <View style={styles.header} className="border-b border-border">
        <Text style={[styles.title, { color: theme.colors.text }]}>
          {t('videos.comments', { defaultValue: 'Comments' })}
        </Text>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={t('common.close', { defaultValue: 'Close' })}>
          <Ionicons name="close" size={22} color={theme.colors.text} />
        </Pressable>
      </View>

      <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
        <Feed
          type="replies"
          filters={{ postId, parentPostId: postId }}
          scrollEnabled={false}
          hideHeader
        />
      </ScrollView>

      <InlineReplyComposer postId={postId} onPosted={onCommentPosted} />
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
