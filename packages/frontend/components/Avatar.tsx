import React from 'react';
import {
  View,
  Image,
  Animated,
  StyleSheet,
  ImageSourcePropType,
  StyleProp,
  ViewStyle,
  ImageStyle,
  TouchableOpacity,
} from 'react-native';
import { VerifiedIcon } from '@/assets/icons/verified-icon';
import { colors } from '../styles/colors';
import DefaultAvatar from '@/assets/images/default-avatar.jpg';
import { useTheme } from '@/hooks/useTheme';
import { oxyServices } from '@/lib/oxyServices';
import { getCachedFileDownloadUrlSync } from '@/utils/imageUrlCache';
import Svg, { Defs, ClipPath, Path, Image as SvgImage } from 'react-native-svg';

const AnimatedImage = Animated.createAnimatedComponent(Image);

// Memoize the default avatar source to prevent re-creation on every render
const DEFAULT_AVATAR_SOURCE = DefaultAvatar;

type AvatarShape = 'circle' | 'squircle';

interface AvatarProps {
  source?: ImageSourcePropType | string | undefined | null;
  size?: number;
  verified?: boolean;
  shape?: AvatarShape;
  style?: StyleProp<ViewStyle>;
  imageStyle?: StyleProp<ImageStyle>;
  label?: string; // kept for backward compat — not rendered
  onPress?: () => void;
  useAnimated?: boolean; // render Animated.Image so parent can pass animated styles in imageStyle
}

// Exact squircle clip path derived from the design polygon, normalized to 0–1 coordinate space.
// Uses viewBox="0 0 1 1" on the SVG so it scales to any avatar size.
const SQUIRCLE_PATH =
  'M0 0.5 L0.00122 0.31674 L0.00489 0.25123 L0.01103 0.20331 L0.01969 0.16478 L0.03097 0.13257 L0.04495 0.10518 L0.0618 0.08177 L0.08177 0.0618 L0.10518 0.04495 L0.13257 0.03097 L0.16478 0.01969 L0.20331 0.01103 L0.25123 0.00489 L0.31674 0.00122 L0.5 0' +
  ' L0.68895 0.0014 L0.7564 0.00561 L0.80559 0.01267 L0.84499 0.02264 L0.87771 0.03564 L0.9053 0.05181 L0.92862 0.07138 L0.94819 0.0947 L0.96436 0.12228 L0.97736 0.15501 L0.98733 0.19441 L0.99439 0.2436 L0.9986 0.31105 L1 0.5' +
  ' L0.9986 0.68895 L0.99439 0.7564 L0.98733 0.80559 L0.97736 0.84499 L0.96436 0.87771 L0.94819 0.9053 L0.92862 0.92862 L0.9053 0.94819 L0.87771 0.96436 L0.84499 0.97736 L0.80559 0.98733 L0.7564 0.99439 L0.68895 0.9986 L0.5 1' +
  ' L0.31105 0.9986 L0.2436 0.99439 L0.19441 0.98733 L0.15501 0.97736 L0.12228 0.96436 L0.0947 0.94819 L0.07138 0.92862 L0.05181 0.9053 L0.03564 0.87771 L0.02264 0.84499 L0.01267 0.80559 L0.00561 0.7564 L0.0014 0.68895 L0 0.5Z';

let _clipIdCounter = 0;

/** Compute border radius for the circle shape */
const getCircleRadius = (size: number) => size / 2;

const Avatar: React.FC<AvatarProps> = ({
  source,
  size = 40,
  verified = false,
  shape = 'circle',
  style,
  imageStyle,
  onPress,
  useAnimated = false,
}) => {
  const theme = useTheme();
  const [errored, setErrored] = React.useState(false);
  const radius = getCircleRadius(size);

  // Unique clip ID per instance (stable across re-renders)
  const clipId = React.useMemo(() => `sqc${_clipIdCounter++}`, []);

  // Resolve source: handles file IDs, HTTP URLs, and ImageSourcePropType objects
  // Uses the app-level oxyServices singleton (same instance as OxyProvider) — no hook needed
  const resolvedSource = React.useMemo(() => {
    if (!source || errored) return undefined;
    if (typeof source !== 'string') return source;
    if (source.startsWith('http')) return source;
    try {
      return getCachedFileDownloadUrlSync(oxyServices, source, 'thumb');
    } catch (e) {
      if (__DEV__) console.warn('[Avatar] Failed to resolve source:', source, e);
      return undefined;
    }
  }, [source, errored]);

  // Memoize imageSource for Image component
  const imageSource = React.useMemo(() => {
    if (resolvedSource) {
      return typeof resolvedSource === 'string' ? { uri: resolvedSource } : resolvedSource;
    }
    return DEFAULT_AVATAR_SOURCE;
  }, [resolvedSource]);

  const Container: any = onPress ? TouchableOpacity : View;

  // Determine which image href to show in SVG
  const svgHref = resolvedSource && !errored ? imageSource : DEFAULT_AVATAR_SOURCE;

  const content = (
    <Animated.View style={[styles.container, { width: size, height: size }, style]}>
      {shape === 'squircle' ? (
        <>
          {/* Hidden RN Image for remote error detection */}
          {resolvedSource && !errored && (
            <Image
              source={imageSource}
              style={styles.errorDetector}
              onError={() => setErrored(true)}
            />
          )}
          <Svg width={size} height={size} viewBox="0 0 1 1">
            <Defs>
              <ClipPath id={clipId}>
                <Path d={SQUIRCLE_PATH} />
              </ClipPath>
            </Defs>
            <SvgImage
              href={svgHref}
              width={1}
              height={1}
              preserveAspectRatio="xMidYMid slice"
              clipPath={`url(#${clipId})`}
            />
          </Svg>
        </>
      ) : (
        <View style={[styles.imageContainer, { width: size, height: size, borderRadius: radius }]}>
          {resolvedSource && !errored ? (
            useAnimated ? (
              <AnimatedImage
                source={imageSource}
                onError={() => setErrored(true)}
                resizeMode="cover"
                style={[StyleSheet.absoluteFillObject, { borderRadius: radius }, imageStyle]}
                defaultSource={DEFAULT_AVATAR_SOURCE}
              />
            ) : (
              <Image
                source={imageSource}
                onError={() => setErrored(true)}
                resizeMode="cover"
                style={[StyleSheet.absoluteFillObject, { borderRadius: radius }, imageStyle]}
                defaultSource={DEFAULT_AVATAR_SOURCE}
              />
            )
          ) : (
            <View style={[styles.fallback, { width: size, height: size, borderRadius: radius, overflow: 'hidden', backgroundColor: theme.colors.backgroundSecondary }]}>
              <Image
                source={DEFAULT_AVATAR_SOURCE}
                style={{ width: size, height: size, borderRadius: radius }}
                resizeMode="cover"
              />
            </View>
          )}
        </View>
      )}

      {verified && (
        <View style={[styles.verifiedBadge, {
          width: size * 0.36,
          height: size * 0.36,
        }]}>
          {/* White border background matching the shield shape */}
          <Svg
            width={size * 0.36}
            height={size * 0.36}
            viewBox="0 0 24 24"
            style={StyleSheet.absoluteFillObject}
          >
            {/* White shield shape as border/background */}
            <Path
              fill="#FFFFFF"
              d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91c-1.31.67-2.2 1.91-2.2 3.34s.89 2.67 2.2 3.34c-.46 1.39-.21 2.9.8 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34z"
            />
          </Svg>
          {/* Verified icon on top */}
          <VerifiedIcon size={Math.round(size * 0.36)} color={colors.primaryColor} />
        </View>
      )}
    </Animated.View>
  );

  return <Container onPress={onPress}>{content}</Container>;
};

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    overflow: 'visible',
    justifyContent: 'center',
    alignItems: 'center',
  },
  imageContainer: {
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
  verifiedBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1,
  },
  fallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorDetector: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
  },
});

export default React.memo(Avatar);
