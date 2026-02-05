/**
 * Unified Loading Component System
 * Consolidates all loading states for consistency and maintainability
 * 
 * Supports:
 * - Spinner (default, inline, centered)
 * - Top spinner (animated, for feeds/lists)
 * - Skeleton loading
 * - Inline loading
 */

import React, { useMemo, useEffect } from 'react';
import { View, Text, StyleSheet, ViewStyle, TextStyle } from 'react-native';
import Animated, { 
  Easing, 
  useAnimatedStyle, 
  useSharedValue, 
  withTiming 
} from 'react-native-reanimated';
import { Loading as LoadingIcon } from '@/assets/icons/loading-icon';
import { useTheme } from '@/hooks/useTheme';
import { SPACING } from '@/styles/spacing';
import { FONT_SIZES } from '@/styles/typography';
import { flattenStyleArray } from '@/utils/theme';
import { memo } from 'react';

export type LoadingVariant = 'spinner' | 'top' | 'skeleton' | 'inline';
export type LoadingSize = 'small' | 'medium' | 'large';

interface BaseLoadingProps {
  /** Variant type */
  variant?: LoadingVariant;
  /** Size of the loading indicator */
  size?: LoadingSize;
  /** Custom color (defaults to theme primary) */
  color?: string;
  /** Custom container style */
  style?: ViewStyle;
  /** Whether loading is active (for animated variants) */
  showLoading?: boolean;
}

interface SpinnerLoadingProps extends BaseLoadingProps {
  variant?: 'spinner';
  /** Optional text to display below spinner */
  text?: string;
  /** Custom style for the text */
  textStyle?: TextStyle;
  /** Whether to show text */
  showText?: boolean;
  /** Custom icon size (overrides size prop) */
  iconSize?: number;
}

interface TopLoadingProps extends BaseLoadingProps {
  variant: 'top';
  /** Custom icon size */
  iconSize?: number;
  /** Custom container height offset */
  heightOffset?: number;
}

interface SkeletonLoadingProps extends BaseLoadingProps {
  variant: 'skeleton';
  /** Number of skeleton lines */
  lines?: number;
  /** Width of skeleton (percentage or pixels) */
  width?: number | string;
  /** Height of skeleton lines */
  lineHeight?: number;
}

interface InlineLoadingProps extends BaseLoadingProps {
  variant: 'inline';
  /** Text to show next to spinner */
  text?: string;
  /** Custom style for the text */
  textStyle?: TextStyle;
}

export type LoadingProps = 
  | SpinnerLoadingProps 
  | TopLoadingProps 
  | SkeletonLoadingProps 
  | InlineLoadingProps;

const SIZE_CONFIG = {
  small: {
    spinner: 20,
    text: FONT_SIZES.sm,
  },
  medium: {
    spinner: 24,
    text: FONT_SIZES.base,
  },
  large: {
    spinner: 32,
    text: FONT_SIZES.md,
  },
} as const;

/**
 * Spinner Loading Component
 */
const SpinnerLoading: React.FC<SpinnerLoadingProps> = ({
  size = 'medium',
  color,
  text,
  textStyle,
  style,
  showText = true,
  iconSize,
}) => {
  const theme = useTheme();
  const sizeConfig = SIZE_CONFIG[size];
  const effectiveIconSize = iconSize ?? sizeConfig.spinner;
  
  // Extract theme values first to avoid optional chaining in dependency arrays
  const themePrimary = theme && theme.colors ? theme.colors.primary : undefined;
  const themeTextSecondary = theme && theme.colors ? theme.colors.textSecondary : undefined;
  const themeText = theme && theme.colors ? theme.colors.text : undefined;
  
  const spinnerColor = useMemo(() => {
    if (color) return color;
    if (themePrimary) return themePrimary;
    return '#000000';
  }, [color, themePrimary]);
  
  const textColor = useMemo(() => {
    if (color) return color;
    if (themeTextSecondary) return themeTextSecondary;
    if (themeText) return themeText;
    return '#666666';
  }, [color, themeTextSecondary, themeText]);
  
  const computedTextStyle = useMemo(
    () => flattenStyleArray([
      styles.text,
      { 
        color: textColor,
        fontSize: sizeConfig.text,
        marginTop: SPACING.sm,
      },
      textStyle,
    ]),
    [textColor, sizeConfig.text, textStyle]
  );
  
  return (
    <View style={flattenStyleArray([styles.container, style])}>
      <LoadingIcon size={effectiveIconSize} color={spinnerColor} />
      {showText && text && (
        <Text style={computedTextStyle}>{text}</Text>
      )}
    </View>
  );
};

/**
 * Top Loading Component (animated, for feeds)
 */
const TopLoading: React.FC<TopLoadingProps> = ({
  size = 'medium',
  color,
  style,
  showLoading = true,
  iconSize,
  heightOffset = 0,
}) => {
  const theme = useTheme();
  const sizeConfig = SIZE_CONFIG[size];
  const effectiveIconSize = iconSize ?? sizeConfig.spinner;
  const targetHeight = Math.max(0, effectiveIconSize + sizeConfig.spinner + heightOffset);
  
  // Extract theme value to avoid optional chaining in dependency arrays
  const themePrimary = theme && theme.colors ? theme.colors.primary : undefined;
  
  const spinnerColor = useMemo(
    () => color ?? themePrimary ?? '#000000',
    [color, themePrimary]
  );
  
  const height = useSharedValue(showLoading ? targetHeight : 0);
  const opacity = useSharedValue(showLoading ? 1 : 0);
  const translateY = useSharedValue(showLoading ? 0 : -targetHeight);
  
  useEffect(() => {
    height.value = withTiming(
      showLoading ? targetHeight : 0,
      { duration: 250, easing: Easing.out(Easing.cubic) }
    );
    opacity.value = withTiming(
      showLoading ? 1 : 0,
      { duration: 250, easing: Easing.out(Easing.cubic) }
    );
    translateY.value = withTiming(
      showLoading ? 0 : -targetHeight,
      { duration: 250, easing: Easing.out(Easing.cubic) }
    );
  }, [showLoading, targetHeight, height, opacity, translateY]);
  
  const containerAnimated = useAnimatedStyle(() => ({
    height: height.value,
  }));
  
  const innerAnimated = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));
  
  return (
    <Animated.View style={[styles.topContainer, containerAnimated]}>
      <Animated.View 
        style={flattenStyleArray([
          styles.topLoadingView,
          { height: targetHeight },
          innerAnimated,
          style,
        ])}
      >
        <LoadingIcon size={effectiveIconSize} color={spinnerColor} />
      </Animated.View>
    </Animated.View>
  );
};

/**
 * Skeleton Loading Component
 */
const SkeletonLoading: React.FC<SkeletonLoadingProps> = ({
  lines = 3,
  width = '100%',
  lineHeight = 16,
  style,
}) => {
  const theme = useTheme();
  
  // Extract theme values first to avoid optional chaining issues
  const themeBackgroundSecondary = theme && theme.colors ? theme.colors.backgroundSecondary : undefined;
  const themeBackground = theme && theme.colors ? theme.colors.background : undefined;
  const backgroundColor = themeBackgroundSecondary ?? themeBackground ?? '#f5f5f5';
  
  const skeletonLines = Array.from({ length: lines }, (_, index) => (
    <View
      key={index}
      style={[
        styles.skeletonLine,
        {
          backgroundColor,
          width: typeof width === 'string' ? width : `${width}%`,
          height: lineHeight,
          marginBottom: index < lines - 1 ? SPACING.sm : 0,
        },
      ]}
    />
  ));
  
  return (
    <View style={flattenStyleArray([styles.skeletonContainer, style])}>
      {skeletonLines}
    </View>
  );
};

/**
 * Inline Loading Component
 */
const InlineLoading: React.FC<InlineLoadingProps> = ({
  size = 'small',
  color,
  text,
  style,
  textStyle,
}) => {
  const theme = useTheme();
  const sizeConfig = SIZE_CONFIG[size];
  
  // Extract theme values first to avoid optional chaining issues
  const themePrimary = theme && theme.colors ? theme.colors.primary : undefined;
  const themeTextSecondary = theme && theme.colors ? theme.colors.textSecondary : undefined;
  const themeText = theme && theme.colors ? theme.colors.text : undefined;
  
  const spinnerColor = useMemo(
    () => color ?? themePrimary ?? '#000000',
    [color, themePrimary]
  );
  
  const textColor = themeTextSecondary ?? themeText ?? '#666666';
  
  return (
    <View style={flattenStyleArray([styles.inlineContainer, style])}>
      <LoadingIcon size={sizeConfig.spinner} color={spinnerColor} />
      {text && (
        <Text 
          style={flattenStyleArray([
            styles.inlineText,
            { 
              color: textColor,
              fontSize: sizeConfig.text,
              marginLeft: SPACING.sm,
            },
            textStyle,
          ])}
        >
          {text}
        </Text>
      )}
    </View>
  );
};

/**
 * Unified Loading Component
 */
const LoadingComponent: React.FC<LoadingProps> = (props) => {
  const variant = props.variant ?? 'spinner';
  
  switch (variant) {
    case 'top':
      return <TopLoading {...props} variant="top" />;
    case 'skeleton':
      return <SkeletonLoading {...props} variant="skeleton" />;
    case 'inline':
      return <InlineLoading {...props} variant="inline" />;
    case 'spinner':
    default:
      return <SpinnerLoading {...props} variant="spinner" />;
  }
};

export const Loading = memo(LoadingComponent);

Loading.displayName = 'Loading';

// Convenience exports for backward compatibility
export const LoadingSpinner = memo((props: Omit<SpinnerLoadingProps, 'variant'>) => (
  <Loading {...props} variant="spinner" />
));

// Compatibility wrapper for old LoadingTopSpinner interface
interface LegacyLoadingTopSpinnerProps {
  size?: number;
  iconSize?: number;
  style?: any;
  showLoading?: boolean;
}

export const LoadingTopSpinner = memo((props: Omit<TopLoadingProps, 'variant'> | LegacyLoadingTopSpinnerProps) => {
  // Handle legacy numeric size prop
  let sizeProp: LoadingSize = 'medium';
  if ('size' in props && typeof props.size === 'number') {
    if (props.size <= 20) sizeProp = 'small';
    else if (props.size <= 24) sizeProp = 'medium';
    else sizeProp = 'large';
  } else if ('size' in props) {
    sizeProp = props.size as LoadingSize;
  }
  
  const { size: _, ...restProps } = props as any;
  
  return (
    <Loading 
      {...restProps} 
      variant="top" 
      size={sizeProp}
      showLoading={props.showLoading ?? true} 
    />
  );
});

LoadingSpinner.displayName = 'LoadingSpinner';
LoadingTopSpinner.displayName = 'LoadingTopSpinner';

export default Loading;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    textAlign: 'center',
  },
  topContainer: {
    width: '100%',
    position: 'relative',
    overflow: 'hidden',
  },
  topLoadingView: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'absolute',
    top: 0,
    left: 0,
  },
  skeletonContainer: {
    width: '100%',
  },
  skeletonLine: {
    borderRadius: 4,
  },
  inlineContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  inlineText: {
    // Text styles applied inline for dynamic color/size
  },
});

