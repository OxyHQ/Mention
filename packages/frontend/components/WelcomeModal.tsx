import { INSTANCE_NAME, INSTANCE_LOGO_URL } from '@/config';
import React, { useEffect, useCallback, useMemo, memo, useId } from 'react';
import {
  View,
  StyleSheet,
  Modal,
  Platform,
  Pressable,
  ImageBackground,
  Image,
  ImageSourcePropType,
  type StyleProp,
  type ViewStyle,
  type GestureResponderEvent,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Backdrop } from '@oxy.so/bloom/overlay';
import { useAuth } from '@oxy.so/services/ui/client';
import { useRouter } from 'expo-router';
import { CloseIcon } from '@/assets/icons/close-icon';
import { LogoIcon } from '@/assets/logo';
import { Button } from '@oxy.so/bloom/button';
import { Divider } from '@oxy.so/bloom/divider';
import { Portal } from '@oxy.so/bloom/portal';
import { Muted } from '@oxy.so/bloom/typography';
import { useTheme } from '@oxy.so/bloom/theme';
import { Z_INDEX } from '@/lib/constants';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Text as SvgText, TSpan } from 'react-native-svg';
import { HIT_SLOP_LG } from '@/styles/hitSlop';


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
 * Renders multiple lines of text with a single top-to-bottom gradient between two stops.
 */
interface GradientStop {
  color: string;
  opacity: number;
}

// Each theme fades the ink into its own sky: black on the day image, white on the night one.
const TAGLINE_GRADIENT = {
  light: { from: { color: '#000000', opacity: 0.8 }, to: { color: '#000000', opacity: 0.2 } },
  dark: { from: { color: '#FFFFFF', opacity: 0.9 }, to: { color: '#FFFFFF', opacity: 0.35 } },
} as const satisfies Record<string, { from: GradientStop; to: GradientStop }>;

// The divider sits on the photo, not on a surface, so Bloom's separator stops
// (neutral-200 / neutral-800) vanish into the clouds. Translucent ink of the
// tagline's colour stays visible over any part of either image.
const DIVIDER_INK = {
  light: { line: 'rgba(0, 0, 0, 0.18)', label: 'rgba(0, 0, 0, 0.55)' },
  dark: { line: 'rgba(255, 255, 255, 0.28)', label: 'rgba(255, 255, 255, 0.75)' },
} as const;

const GradientText: React.FC<{
  lines: string[];
  style?: StyleProp<ViewStyle>;
  fontSize: number;
  fontWeight?: string;
  from: GradientStop;
  to: GradientStop;
}> = ({ lines, style, fontSize, fontWeight = '600', from, to }) => {
  const gradientId = useId();
  const lineHeight = fontSize * 1.25; // Slightly reduced gap between lines
  // The last baseline sits at lines * lineHeight; without room below it the
  // SVG clips descenders ("y", "g", "p") on the final line.
  const descender = fontSize * 0.3;
  const totalHeight = lines.length * lineHeight + descender;
  
  // Estimate text width based on longest line
  const longestLine = lines.reduce((a, b) => (a.length > b.length ? a : b), '');
  const estimatedWidth = Math.max(longestLine.length * fontSize * 0.7, 300);

  // Use SVG with gradient applied to all lines together
  return (
    <View style={[{ alignItems: 'center', justifyContent: 'center', position: 'relative', marginBottom: 4 }, style]}>
      <Svg width={estimatedWidth} height={totalHeight}>
        <Defs>
          {/* Gradient runs from 10% to 90% of the text block's height */}
          <SvgLinearGradient id={gradientId} x1="0%" y1="10%" x2="0%" y2="90%">
            <Stop offset="0%" stopColor={from.color} stopOpacity={from.opacity} />
            <Stop offset="100%" stopColor={to.color} stopOpacity={to.opacity} />
          </SvgLinearGradient>
        </Defs>
        {/* Text with gradient applied - all lines together */}
        <SvgText
          x="50%"
          y={lineHeight}
          fontSize={fontSize}
          fontWeight={fontWeight}
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
  const insets = useSafeAreaInsets();
  const { signIn } = useAuth();
  const router = useRouter();
  const theme = useTheme();

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

  const handleContentPress = useCallback((e: GestureResponderEvent) => {
    e.stopPropagation();
  }, []);

  const handleCreateAccount = useCallback(() => {
    stableOnClose();
    signIn().catch(() => {});
  }, [stableOnClose, signIn]);

  const handleExploreApp = useCallback(() => {
    stableOnClose();
    router.push('/');
  }, [stableOnClose, router]);

  const handleSignIn = useCallback(() => {
    stableOnClose();
    signIn().catch(() => {});
  }, [stableOnClose, signIn]);

  // Animated styles
  const contentAnimatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [
      { scale: scale.value },
      { translateY: translateY.value },
    ],
  }), []);

  const backgroundImage: ImageSourcePropType = useMemo(
    () => theme.isDark
      ? require('@/assets/images/welcome-modal-bg-dark.jpg')
      : require('@/assets/images/welcome-modal-bg.jpg'),
    [theme.isDark]
  );

  // Early return if not visible
  if (!visible) {
    return null;
  }

  const modalContent = (
    <GestureHandlerRootView style={styles.modalContainer}>
      {/* Bloom's shared backdrop — same blur and dim as every dialog, sheet and
          menu. Hand-rolling one here is what made this modal look different. */}
      <Backdrop onPress={handleBackdropPress} progress={opacity} />

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
            style={[styles.modalBox, { backgroundColor: theme.colors.background }]}
            imageStyle={styles.modalBoxImage}
            resizeMode="cover"
          >
            {/* Close Button */}
            <Pressable
              onPress={handleBackdropPress}
              style={styles.closeButton}
              hitSlop={HIT_SLOP_LG}
            >
              <CloseIcon className="text-foreground" size={20} />
            </Pressable>

            {/* Logo */}
            <View style={styles.logoContainer}>
              {INSTANCE_LOGO_URL ? (
                <Image source={{ uri: INSTANCE_LOGO_URL }} className="w-12 h-12" resizeMode="contain" accessibilityLabel={INSTANCE_NAME} />
              ) : <LogoIcon
                className={theme.isDark ? undefined : 'text-primary'}
                color={theme.isDark ? '#FFFFFF' : undefined}
                size={40}
                style={styles.logoIcon}
              />}
              {INSTANCE_NAME !== 'Mention' ? <Muted>{INSTANCE_NAME}</Muted> : null}
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
                {...(theme.isDark ? TAGLINE_GRADIENT.dark : TAGLINE_GRADIENT.light)}
              />
            </View>

            {/* Buttons and Links Container - positioned in middle */}
            <View style={styles.actionsContainer}>
              {/* Bloom's AuthCard layout: the primary action, an "or" divider 20
                  above and below, then the alternative at the same width. */}
              <View style={styles.choices}>
                <Button variant="primary" fullWidth onPress={handleCreateAccount}>
                  Create account
                </Button>
                <View style={styles.choiceDivider}>
                  <Divider
                    color={theme.isDark ? DIVIDER_INK.dark.line : DIVIDER_INK.light.line}
                    textStyle={{ color: theme.isDark ? DIVIDER_INK.dark.label : DIVIDER_INK.light.label }}
                  >
                    or
                  </Divider>
                </View>
                <Button variant="ghost" fullWidth onPress={handleExploreApp}>
                  Explore the app
                </Button>
              </View>

              {/* Sign in prompt */}
              <View style={styles.signInContainer}>
                <Muted>Already have an account? </Muted>
                <Button variant="link" onPress={handleSignIn}>
                  Sign in
                </Button>
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
    ...StyleSheet.absoluteFill,
    zIndex: Z_INDEX.MODAL,
    // The Bloom Portal root has `pointer-events: none` so the idle
    // portal does not intercept clicks on the underlying app. While
    // this modal is mounted it must capture clicks (backdrop dismiss,
    // button taps), so opt back in here. No-op on native.
    pointerEvents: 'auto',
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
    // 4:3, the proportion of the background art — shrink both sides together.
    maxWidth: 640,
    maxHeight: 480,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalBox: {
    borderRadius: 20,
    overflow: 'hidden',
    boxShadow: '0px 4px 8px 0px rgba(0, 0, 0, 0.3)',
    elevation: 8,
    width: '100%',
    height: '100%',
    padding: 24,
    justifyContent: 'space-between',
  },
  modalBoxImage: {
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
    marginTop: 8,
    marginBottom: 16,
  },
  logoIcon: {
    // No margin needed since there's no text next to it
  },
  taglineContainer: {
    alignItems: 'center',
    marginBottom: 0,
    marginTop: 24,
  },
  actionsContainer: {
    alignItems: 'center',
    gap: 12,
    marginTop: 'auto',
    marginBottom: 'auto',
  },
  choices: {
    width: '100%',
    maxWidth: 280,
  },
  choiceDivider: {
    marginVertical: 20,
  },
  signInContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingBottom: 8,
  },
});

// Memoize component to prevent unnecessary re-renders
export default memo(WelcomeModal);
