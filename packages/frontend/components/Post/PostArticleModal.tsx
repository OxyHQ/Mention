import React, { useEffect, useMemo, useState, useCallback, memo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
} from 'react-native';
import { BlurView } from 'expo-blur';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { CloseIcon } from '@/assets/icons/close-icon';
import { HeaderIconButton } from '@/components/HeaderIconButton';
import { articleService } from '@/services/articleService';
import LinkifiedText from '@/components/common/LinkifiedText';
import { Portal } from '@/components/Portal';
import { Z_INDEX } from '@/lib/constants';

const AnimatedBlurView = Animated.createAnimatedComponent(BlurView);

/**
 * Animation configuration for smooth, non-bouncy modal transitions
 */
const ANIMATION_CONFIG = {
  IN: {
    duration: 300,
    easing: Easing.out(Easing.cubic),
  },
  OUT: {
    duration: 250,
    easing: Easing.in(Easing.cubic),
  },
} as const;

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
  onClose
}) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const [articleTitle, setArticleTitle] = useState<string | undefined>(title);
  const [articleBody, setArticleBody] = useState<string | undefined>(body);
  const [isLoading, setIsLoading] = useState<boolean>(Boolean(articleId && !body));
  const [loadError, setLoadError] = useState<string | null>(null);

  // Animation values - initialized once
  const opacity = useSharedValue(0);
  const scale = useSharedValue(0.95);
  const translateY = useSharedValue(20);

  // Memoize onClose to prevent unnecessary re-renders
  const stableOnClose = useCallback(onClose, [onClose]);

  // Optimize animation effect - smooth, non-bouncy animations
  useEffect(() => {
    if (visible) {
      // Animate in - smooth fade and slide up
      opacity.value = withTiming(1, ANIMATION_CONFIG.IN);
      scale.value = withTiming(1, ANIMATION_CONFIG.IN);
      translateY.value = withTiming(0, ANIMATION_CONFIG.IN);
    } else {
      // Animate out - smooth fade and slide down
      opacity.value = withTiming(0, ANIMATION_CONFIG.OUT);
      scale.value = withTiming(0.95, ANIMATION_CONFIG.OUT);
      translateY.value = withTiming(20, ANIMATION_CONFIG.OUT);
    }
  }, [visible, opacity, scale, translateY]);

  // Fetch article data when modal becomes visible and articleId is provided
  useEffect(() => {
    if (!visible) return;

    let isMounted = true;
    const needsFetch = articleId && !body;

    if (needsFetch) {
      setIsLoading(true);
      setLoadError(null);
      articleService.getArticle(articleId)
        .then((article) => {
          if (!isMounted) return;
          setArticleTitle(article.title || title);
          setArticleBody(article.body || body);
        })
        .catch((error) => {
          console.error('Failed to load article content:', error);
          if (isMounted) {
            setLoadError(t('post.articleSheet.loadError', { defaultValue: 'Failed to load article.' }));
          }
        })
        .finally(() => {
          if (isMounted) {
            setIsLoading(false);
          }
        });
    } else {
      // Use provided data directly when no fetch is needed
      setArticleTitle(title);
      setArticleBody(body);
      setIsLoading(false);
    }

    return () => {
      isMounted = false;
    };
  }, [visible, articleId, body, title, t]);

  // Memoize trimmed values
  const trimmedTitle = useMemo(() => articleTitle?.trim(), [articleTitle]);
  const trimmedBody = useMemo(() => articleBody?.trim(), [articleBody]);

  // Memoize translation strings
  const titleText = useMemo(
    () => t('post.articleSheet.title', { defaultValue: 'Article' }),
    [t]
  );
  const untitledText = useMemo(
    () => t('post.articleSheet.untitled', { defaultValue: 'Untitled article' }),
    [t]
  );
  const emptyBodyText = useMemo(
    () => t('post.articleSheet.emptyBody', { defaultValue: 'No content provided.' }),
    [t]
  );

  // Animated styles - memoized with worklets
  const backdropAnimatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }), []);

  const contentAnimatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [
      { scale: scale.value },
      { translateY: translateY.value },
    ],
  }), []);

  // Memoize handlers
  const handleBackdropPress = useCallback(() => {
    stableOnClose();
  }, [stableOnClose]);

  const handleContentPress = useCallback((e: any) => {
    e.stopPropagation();
  }, []);

  // Memoize style objects to prevent recreation
  const headerStyle = useMemo(
    () => [styles.header, { borderBottomColor: theme.colors.border }],
    [theme.colors.border]
  );

  const contentContainerStyle = useMemo(
    () => [
      styles.contentContainer,
      {
        backgroundColor: theme.colors.background,
        paddingTop: insets.top,
      },
      contentAnimatedStyle,
    ],
    [theme.colors.background, insets.top, contentAnimatedStyle]
  );

  const overlayColor = useMemo(
    () => theme.colors.overlay || 'rgba(0, 0, 0, 0.5)',
    [theme.colors.overlay]
  );

  // Memoize blur tint
  const blurTint = useMemo(
    () => (theme.isDark ? 'dark' : 'light'),
    [theme.isDark]
  );

  // Memoize text styles
  const headerTitleStyle = useMemo(
    () => [styles.headerTitle, { color: theme.colors.text }],
    [theme.colors.text]
  );

  const articleTitleStyle = useMemo(
    () => [styles.articleTitle, { color: theme.colors.text }],
    [theme.colors.text]
  );

  const articleBodyStyle = useMemo(
    () => [styles.articleBody, { color: theme.colors.textSecondary }],
    [theme.colors.textSecondary]
  );

  const articleBodyPlaceholderStyle = useMemo(
    () => [styles.articleBodyPlaceholder, { color: theme.colors.textSecondary }],
    [theme.colors.textSecondary]
  );

  const errorStyle = useMemo(
    () => [styles.articleBodyPlaceholder, { color: theme.colors.error }],
    [theme.colors.error]
  );

  // Early return if not visible (prevents unnecessary rendering)
  if (!visible) {
    return null;
  }

  const modalContent = (
    <GestureHandlerRootView style={styles.modalContainer}>
      <Pressable
        style={StyleSheet.absoluteFillObject}
        onPress={handleBackdropPress}
      >
        <AnimatedBlurView
          intensity={80}
          tint={blurTint}
          style={[StyleSheet.absoluteFillObject, backdropAnimatedStyle]}
        >
          <Animated.View
            style={[
              StyleSheet.absoluteFillObject,
              { backgroundColor: overlayColor },
              backdropAnimatedStyle,
            ]}
          />
        </AnimatedBlurView>
      </Pressable>

      <Animated.View
        style={contentContainerStyle}
        pointerEvents="box-none"
      >
        <Pressable
          onPress={handleContentPress}
          style={styles.pressableContent}
        >
          <View style={headerStyle}>
            <HeaderIconButton onPress={stableOnClose} style={styles.closeButton}>
              <CloseIcon size={20} color={theme.colors.text} />
            </HeaderIconButton>
            <Text style={headerTitleStyle} pointerEvents="none">
              {titleText}
            </Text>
            <View style={styles.headerRight} />
          </View>

          {isLoading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="small" color={theme.colors.primary} />
            </View>
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
                  style={articleTitleStyle}
                  linkStyle={[{ color: theme.colors.primary }]}
                />
                {trimmedBody ? (
                  <LinkifiedText
                    text={trimmedBody}
                    style={articleBodyStyle}
                    linkStyle={[{ color: theme.colors.primary }]}
                  />
                ) : loadError ? (
                  <Text style={errorStyle}>
                    {loadError}
                  </Text>
                ) : (
                  <Text style={articleBodyPlaceholderStyle}>
                    {emptyBodyText}
                  </Text>
                )}
              </View>
            </ScrollView>
          )}
        </Pressable>
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
        onRequestClose={stableOnClose}
        hardwareAccelerated={Platform.OS === 'android'}
      >
        {modalContent}
      </Modal>
    </Portal>
  );
};

// Memoize component to prevent unnecessary re-renders
export default memo(PostArticleModal);

const styles = StyleSheet.create({
  modalContainer: {
    ...Platform.select({
      web: {
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: Z_INDEX.MODAL,
      },
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
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: -2,
    },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    minHeight: 48,
    borderBottomWidth: 1,
  },
  closeButton: {
    marginRight: 6,
    zIndex: 1,
  },
  headerTitle: {
    position: 'absolute',
    left: 0,
    right: 0,
    textAlign: 'center',
    fontSize: 18,
    fontWeight: '700',
    pointerEvents: 'none',
  },
  headerRight: {
    width: 36,
    height: 36,
    marginLeft: 'auto',
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
  articleBodyPlaceholder: {
    fontSize: 14,
    fontStyle: 'italic',
  },
  loadingContainer: {
    minHeight: 200,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  pressableContent: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
});

