import { DetailSkeleton } from '@/components/loading/ContentSkeleton';
import type React from 'react';
import { useEffect, useMemo, useState, useCallback, memo } from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  Modal,
  Platform,
  type GestureResponderEvent,
  type ViewStyle,
} from 'react-native';
import { Backdrop } from '@oxy.so/bloom/overlay';
import { createTokenStyles } from '@oxy.so/bloom/theme';
import Animated from 'react-native-reanimated';
import { ScaleAndFadeIn, ScaleAndFadeOut } from '@oxy.so/bloom/motion';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { articleService } from '@/services/articleService';
import { LinkifiedText } from '@/components/common/LinkifiedText';
import { Portal } from '@oxy.so/bloom/portal';
import { logger } from '@oxy.so/core/logger';
import {
  Embed,
  HStack,
  RawText,
  VStack,
  toElement,
  Button as LButton,
  Icon,
} from '@oxy.so/bloom-language';

/*
 * A full-screen reader, which Bloom's `Dialog` has no placement for (its
 * centered card caps at 90% height and its bottom sheet hugs its content), so
 * the surface stays a Portal (web) / RN `Modal` (native: translucent status
 * bar, Android back → `onClose`). The enter/exit are Bloom's shared motion
 * presets rather than hand-timed shared values.
 */

interface PostArticleModalProps {
  visible: boolean;
  articleId?: string;
  title?: string;
  body?: string;
  onClose: () => void;
}

const PostArticleModal: React.FC<PostArticleModalProps> = ({
  visible,
  articleId,
  title,
  body,
  onClose,
}) => {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const ink = useInkStyles();

  // Only use state for async-fetched article data; use props directly otherwise
  const [fetchedTitle, setFetchedTitle] = useState<string | undefined>(undefined);
  const [fetchedBody, setFetchedBody] = useState<string | undefined>(undefined);
  const [isLoading, setIsLoading] = useState<boolean>(Boolean(articleId && !body));
  const [loadError, setLoadError] = useState<string | null>(null);

  const needsFetch = Boolean(articleId && !body);

  // Fetch article data when modal becomes visible and articleId is provided
  useEffect(() => {
    if (!visible || !needsFetch || !articleId) return;

    let isMounted = true;
    setIsLoading(true);
    setLoadError(null);
    articleService
      .getArticle(articleId)
      .then((article) => {
        if (!isMounted) return;
        setFetchedTitle(article.title || title);
        setFetchedBody(article.body || body);
      })
      .catch(() => {
        logger.error('Failed to load article content');
        if (isMounted) {
          setLoadError(
            t('post.articleSheet.loadError', { defaultValue: 'Failed to load article.' }),
          );
        }
      })
      .finally(() => {
        if (isMounted) {
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [visible, articleId, needsFetch, body, title, t]);

  // Prefer props directly; fall back to fetched data
  const articleTitle = needsFetch ? fetchedTitle : title;
  const articleBody = needsFetch ? fetchedBody : body;

  // Memoize trimmed values
  const trimmedTitle = useMemo(() => articleTitle?.trim(), [articleTitle]);
  const trimmedBody = useMemo(() => articleBody?.trim(), [articleBody]);

  // Memoize translation strings
  const titleText = useMemo(() => t('post.articleSheet.title', { defaultValue: 'Article' }), [t]);
  const untitledText = useMemo(
    () => t('post.articleSheet.untitled', { defaultValue: 'Untitled article' }),
    [t],
  );
  const emptyBodyText = useMemo(
    () => t('post.articleSheet.emptyBody', { defaultValue: 'No content provided.' }),
    [t],
  );

  // Memoize handlers
  const handleBackdropPress = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleContentPress = useCallback((e: GestureResponderEvent) => {
    e.stopPropagation();
  }, []);

  // Memoize style objects to prevent recreation
  const contentContainerStyle = useMemo(
    () => [
      styles.contentContainer,
      {
        paddingTop: insets.top,
      },
    ],
    [insets.top],
  );

  const articleTitleStyle = styles.articleTitle;
  const articleBodyStyle = styles.articleBody;

  // Early return if not visible (prevents unnecessary rendering)
  if (!visible) {
    return null;
  }

  const modalContent = (
    <GestureHandlerRootView style={styles.modalContainer}>
      {/* Bloom's shared backdrop — one blur + dim for every surface. */}
      <Backdrop onPress={handleBackdropPress} />

      <Animated.View
        entering={ScaleAndFadeIn}
        exiting={ScaleAndFadeOut}
        pointerEvents="box-none"
        style={[ink.surface, contentContainerStyle]}
      >
        {toElement(
          VStack(
            HStack(
              LButton(Icon(RiCloseLine))
                .shape('circle')
                .style('subtle')
                .tint('neutral')
                .label(t('common.close', { defaultValue: 'Close' }))
                .onPress(onClose)
                .margin('right', '6')
                .zIndex('raised'),
              RawText(titleText)
                .foreground('foreground')
                .font('18')
                .weight('bold')
                .textAlign('center')
                .position({ left: 'none', right: 'none' })
                .allowsHitTesting(false),
              VStack().frame({ width: '36', height: '36' }).margin('left', 'auto'),
            )
              .align('center')
              .padding('horizontal', 'lg')
              .padding('vertical', 'sm')
              .frame({ minHeight: '48' })
              .border('border', 'thin', 'bottom'),
            Embed(
              isLoading ? (
                <ScrollView style={styles.scrollView}>
                  <DetailSkeleton />
                </ScrollView>
              ) : (
                <ScrollView
                  style={styles.scrollView}
                  contentContainerStyle={styles.content}
                  showsVerticalScrollIndicator={true}
                  bounces={true}
                >
                  <View style={styles.articleWrapper}>
                    <LinkifiedText
                      text={trimmedTitle || untitledText}
                      style={[ink.foreground, articleTitleStyle]}
                    />
                    {trimmedBody ? (
                      <LinkifiedText text={trimmedBody} style={[ink.muted, articleBodyStyle]} />
                    ) : loadError ? (
                      toElement(RawText(loadError).foreground('destructive').font('14').italic())
                    ) : (
                      toElement(RawText(emptyBodyText).foreground('muted').font('14').italic())
                    )}
                  </View>
                </ScrollView>
              ),
            ),
          )
            .grow()
            .onPress(handleContentPress),
        )}
      </Animated.View>
    </GestureHandlerRootView>
  );

  // On web: Portal handles full-screen positioning via fixed positioning
  if (Platform.OS === 'web') {
    return <Portal>{modalContent}</Portal>;
  }

  // On native: Use Modal for system integration (status bar, back button, etc.)
  // Portal ensures it renders at root level for proper z-index stacking
  return (
    <Portal>
      <Modal
        visible={visible}
        transparent
        animationType="none"
        statusBarTranslucent={Platform.OS === 'android'}
        onRequestClose={onClose}
        hardwareAccelerated={Platform.OS === 'android'}
      >
        {modalContent}
      </Modal>
    </Portal>
  );
};

// Memoize component to prevent unnecessary re-renders
export default memo(PostArticleModal);

// `position: fixed` on the web: React Native types `position` without it, while
// react-native-web passes it through as CSS (Bloom's own WEB_POSITION_FIXED).
const WEB_POSITION_FIXED = 'fixed' as ViewStyle['position'];

// The reader's theme colours, painted before its own styles as the classes were.
const useInkStyles = createTokenStyles((t) => ({
  surface: { backgroundColor: t.background },
  foreground: { color: t.foreground },
  muted: { color: t.mutedForeground },
}));

const styles = StyleSheet.create({
  modalContainer: {
    // WEB: a full-screen overlay fixed to the viewport, above the app's layers.
    // NATIVE: the Portal-mounted root fills via flex.
    ...Platform.select({
      web: { position: WEB_POSITION_FIXED, inset: 0, zIndex: 10000 },
      default: {
        flex: 1,
      },
    }),
  },
  contentContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    top: 0,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    overflow: 'hidden',
    boxShadow: '0px -2px 8px 0px rgba(0, 0, 0, 0.25)',
    elevation: 10,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 40,
  },
  articleWrapper: {
    maxWidth: 1100,
    width: '100%',
    alignSelf: 'center',
    gap: 16,
  },
  articleTitle: {
    fontSize: 24,
    fontWeight: '700',
    lineHeight: 30,
  },
  articleBody: {
    fontSize: 15,
    lineHeight: 22,
  },
  pressableContent: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
});
