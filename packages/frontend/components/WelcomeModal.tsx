import { INSTANCE_NAME, INSTANCE_LOGO_URL } from '@/config';
import React, { useCallback, useMemo, memo, useId } from 'react';
import {
  View,
  StyleSheet,
  Platform,
  Pressable,
  ImageBackground,
  Image,
  ImageSourcePropType,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useAuth } from '@oxy.so/services/ui/client';
import { useRouter } from 'expo-router';
import { CloseIcon } from '@/assets/icons/close-icon';
import { LogoIcon } from '@/assets/logo';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Divider } from '@oxy.so/bloom/divider';
import { Muted } from '@oxy.so/bloom/typography';
import { useTheme } from '@oxy.so/bloom/theme';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Text as SvgText, TSpan } from 'react-native-svg';
import { HIT_SLOP_LG } from '@/styles/hitSlop';

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
  const { signIn } = useAuth();
  const router = useRouter();
  const theme = useTheme();

  const handleCreateAccount = useCallback(() => {
    onClose();
    signIn().catch(() => {});
  }, [onClose, signIn]);

  const handleExploreApp = useCallback(() => {
    onClose();
    router.push('/');
  }, [onClose, router]);

  const handleSignIn = useCallback(() => {
    onClose();
    signIn().catch(() => {});
  }, [onClose, signIn]);

  const backgroundImage: ImageSourcePropType = useMemo(
    () => theme.isDark
      ? require('@/assets/images/welcome-modal-bg-dark.jpg')
      : require('@/assets/images/welcome-modal-bg.jpg'),
    [theme.isDark]
  );

  // Bloom's `Dialog` owns the surface: the shared backdrop (tap to dismiss),
  // the zoom-and-fade enter/exit, Escape on web, and on native a real RN
  // `Modal` window (translucent status bar, Android back → `onClose`). The
  // card itself stays full-bleed art, so the dialog adds no padding and does
  // not scroll or morph.
  return (
    <Dialog
      open={visible}
      onClose={onClose}
      label={`Welcome to ${INSTANCE_NAME}`}
      maxWidth={640}
      contentPadding={0}
      scrollable={false}
      morph={false}
      style={styles.panel}
    >
      <ImageBackground
        source={backgroundImage}
        style={styles.modalBox}
        imageStyle={styles.modalBoxImage}
        resizeMode="cover"
      >
        {/* Close Button */}
        <Pressable
          onPress={onClose}
          style={styles.closeButton}
          hitSlop={HIT_SLOP_LG}
          accessibilityRole="button"
          accessibilityLabel="Close"
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
            <Button appearance="solid" tone="accent" fullWidth onPress={handleCreateAccount}>
              Create account
            </Button>
            <Divider
              spacing={20}
              color={theme.isDark ? DIVIDER_INK.dark.line : DIVIDER_INK.light.line}
              textStyle={{ color: theme.isDark ? DIVIDER_INK.dark.label : DIVIDER_INK.light.label }}
            >
              or
            </Divider>
            <Button appearance="plain" tone="neutral" fullWidth onPress={handleExploreApp}>
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
    </Dialog>
  );
};

const styles = StyleSheet.create({
  // 4:3, the proportion of the background art. Bloom caps the card at
  // `maxWidth` and 90% of the viewport height; on native the centered card is
  // content-hugging, so the art box carries the height itself there.
  panel: {
    height: Platform.OS === 'web' ? 480 : undefined,
  },
  modalBox: {
    width: '100%',
    ...(Platform.OS === 'web' ? { flex: 1 } : { minHeight: 480 }),
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
  signInContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingBottom: 8,
  },
});

// Memoize component to prevent unnecessary re-renders
export default memo(WelcomeModal);
