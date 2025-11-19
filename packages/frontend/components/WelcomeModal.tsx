import React, { useEffect, useCallback, useMemo, memo, useId } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Platform,
  Pressable,
  ImageBackground,
  ImageSourcePropType,
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
import { useOxy } from '@oxyhq/services';
import { useRouter } from 'expo-router';
import { CloseIcon } from '@/assets/icons/close-icon';
import { LogoIcon } from '@/assets/logo';
import { Portal } from '@/components/Portal';
import { Z_INDEX } from '@/lib/constants';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Text as SvgText, TSpan } from 'react-native-svg';

const AnimatedBlurView = Animated.createAnimatedComponent(BlurView);

/**
 * Animation configuration for smooth modal transitions
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

interface WelcomeModalProps {
  visible: boolean;
  onClose: () => void;
}

/**
 * GradientText Component
 * Renders multiple lines of text with a single gradient from top (80% opacity) to bottom (20% opacity)
 */
const GradientText: React.FC<{
  lines: string[];
  style?: any;
  fontSize: number;
  fontWeight?: string;
  fontFamily?: string;
}> = ({ lines, style, fontSize, fontWeight = '600', fontFamily = 'Inter-SemiBold' }) => {
  const gradientId = useId();
  const lineHeight = fontSize * 1.25; // Slightly reduced gap between lines
  const totalHeight = lines.length * lineHeight;
  
  // Estimate text width based on longest line
  const longestLine = lines.reduce((a, b) => (a.length > b.length ? a : b), '');
  const estimatedWidth = Math.max(longestLine.length * fontSize * 0.7, 300);

  // Use SVG with gradient applied to all lines together
  return (
    <View style={[{ alignItems: 'center', justifyContent: 'center', position: 'relative', marginBottom: 4 }, style]}>
      <Svg width={estimatedWidth} height={totalHeight}>
        <Defs>
          {/* Gradient from top 10% to bottom 90%: 80% opacity to 20% opacity */}
          <SvgLinearGradient id={gradientId} x1="0%" y1="10%" x2="0%" y2="90%">
            <Stop offset="0%" stopColor="#000000" stopOpacity="0.8" />
            <Stop offset="100%" stopColor="#000000" stopOpacity="0.2" />
          </SvgLinearGradient>
        </Defs>
        {/* Text with gradient applied - all lines together */}
        <SvgText
          x="50%"
          y={lineHeight}
          fontSize={fontSize}
          fontWeight={fontWeight}
          fontFamily={fontFamily}
          fill={`url(#${gradientId})`}
          textAnchor="middle"
        >
          {lines.map((line, index) => (
            <TSpan
              key={index}
              x="50%"
              dy={index === 0 ? 0 : lineHeight}
            >
              {line}
            </TSpan>
          ))}
        </SvgText>
      </Svg>
    </View>
  );
};

const WelcomeModal: React.FC<WelcomeModalProps> = ({
  visible,
  onClose,
}) => {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { isAuthenticated, showBottomSheet } = useOxy();
  const router = useRouter();

  // Animation values
  const opacity = useSharedValue(0);
  const scale = useSharedValue(0.95);
  const translateY = useSharedValue(20);

  // Memoize onClose to prevent unnecessary re-renders
  const stableOnClose = useCallback(onClose, [onClose]);

  // Handle animation
  useEffect(() => {
    if (visible) {
      opacity.value = withTiming(1, ANIMATION_CONFIG.IN);
      scale.value = withTiming(1, ANIMATION_CONFIG.IN);
      translateY.value = withTiming(0, ANIMATION_CONFIG.IN);
    } else {
      opacity.value = withTiming(0, ANIMATION_CONFIG.OUT);
      scale.value = withTiming(0.95, ANIMATION_CONFIG.OUT);
      translateY.value = withTiming(20, ANIMATION_CONFIG.OUT);
    }
  }, [visible, opacity, scale, translateY]);

  // Handlers
  const handleBackdropPress = useCallback(() => {
    stableOnClose();
  }, [stableOnClose]);

  const handleContentPress = useCallback((e: any) => {
    e.stopPropagation();
  }, []);

  const handleCreateAccount = useCallback(() => {
    stableOnClose();
    showBottomSheet?.('SignIn');
  }, [stableOnClose, showBottomSheet]);

  const handleExploreApp = useCallback(() => {
    stableOnClose();
    router.push('/');
  }, [stableOnClose, router]);

  const handleSignIn = useCallback(() => {
    stableOnClose();
    showBottomSheet?.('SignIn');
  }, [stableOnClose, showBottomSheet]);

  // Animated styles
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

  // Memoize styles
  const blurTint = useMemo(
    () => (theme.isDark ? 'dark' : 'light'),
    [theme.isDark]
  );

  const overlayColor = useMemo(
    () => theme.colors.overlay || 'rgba(0, 0, 0, 0.5)',
    [theme.colors.overlay]
  );

  // Load background image
  const backgroundImage: ImageSourcePropType = useMemo(
    () => require('@/assets/images/welcome-modal-bg.jpg'),
    []
  );

  // Early return if not visible
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
        style={[
          styles.modalContent,
          contentAnimatedStyle,
          {
            paddingTop: insets.top,
            paddingBottom: insets.bottom,
            paddingHorizontal: 20,
          },
        ]}
      >
        <Pressable onPress={handleContentPress} style={styles.contentPressable}>
          <ImageBackground
            source={backgroundImage}
            style={styles.modalBox}
            imageStyle={styles.modalBoxImage}
          >
            {/* Close Button */}
            <Pressable
              onPress={handleBackdropPress}
              style={styles.closeButton}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <CloseIcon color={theme.colors.text} size={20} />
            </Pressable>

            {/* Logo */}
            <View style={styles.logoContainer}>
              <LogoIcon
                color={theme.colors.primary}
                size={40}
                style={styles.logoIcon}
              />
            </View>

            {/* Tagline with single gradient for all lines */}
            <View style={styles.taglineContainer}>
              <GradientText
                lines={[
                  'Real people.',
                  'Real conversations.',
                  'Social media you control.',
                ]}
                fontSize={32}
                fontWeight="600"
                fontFamily="Inter-SemiBold"
              />
            </View>

            {/* Buttons and Links Container - positioned in middle */}
            <View style={styles.actionsContainer}>
              {/* Create Account Button */}
              <Pressable
                onPress={handleCreateAccount}
                style={[styles.createAccountButton, { backgroundColor: theme.colors.primary }]}
              >
                <Text style={styles.createAccountButtonText}>Create account</Text>
              </Pressable>

              {/* Explore the app link */}
              <Pressable onPress={handleExploreApp} style={styles.exploreLink}>
                <Text style={[styles.exploreLinkText, { color: theme.colors.primary }]}>
                  Explore the app
                </Text>
              </Pressable>

              {/* Sign in prompt */}
              <View style={styles.signInContainer}>
                <Text style={[styles.signInPrompt, { color: theme.colors.textSecondary }]}>
                  Already have an account?{' '}
                </Text>
                <Pressable onPress={handleSignIn}>
                  <Text style={[styles.signInLink, { color: theme.colors.primary }]}>
                    Sign in
                  </Text>
                </Pressable>
              </View>
            </View>
          </ImageBackground>
        </Pressable>
      </Animated.View>
    </GestureHandlerRootView>
  );

  // On web: Portal handles full-screen positioning via fixed positioning
  if (Platform.OS === 'web') {
    return <Portal>{modalContent}</Portal>;
  }

  // On native: Use Modal for system integration (status bar, back button, etc.)
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

const styles = StyleSheet.create({
  modalContainer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: Z_INDEX.MODAL,
  },
  modalContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
    height: '100%',
  },
  contentPressable: {
    width: '100%',
    height: '100%',
    maxWidth: 800,
    maxHeight: 600,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalBox: {
    borderRadius: 20,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
    width: '100%',
    height: '100%',
    padding: 32,
    justifyContent: 'space-between',
  },
  modalBoxImage: {
    resizeMode: 'cover',
    opacity: 0.95,
  },
  closeButton: {
    position: 'absolute',
    top: 16,
    right: 16,
    zIndex: 1,
    padding: 4,
  },
  logoContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
    marginBottom: 24,
  },
  logoIcon: {
    // No margin needed since there's no text next to it
  },
  taglineContainer: {
    alignItems: 'center',
    marginBottom: 0,
  },
  actionsContainer: {
    alignItems: 'center',
    gap: 12,
    marginTop: 'auto',
    marginBottom: 'auto',
  },
  createAccountButton: {
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 24,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
    alignSelf: 'center',
  },
  createAccountButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
    fontFamily: 'Inter-SemiBold',
  },
  exploreLink: {
    alignItems: 'center',
    paddingVertical: 6,
  },
  exploreLinkText: {
    fontSize: 14,
    fontWeight: '500',
    fontFamily: 'Inter-Medium',
  },
  signInContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingBottom: 8,
  },
  signInPrompt: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  signInLink: {
    fontSize: 14,
    fontWeight: '500',
    fontFamily: 'Inter-Medium',
  },
});

// Memoize component to prevent unnecessary re-renders
export default memo(WelcomeModal);




